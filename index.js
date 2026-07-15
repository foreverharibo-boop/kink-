// 킨크 추출기 - CharSheet 기반 킨크 추출 + AI 추천 (텍스트 출력)
const EXT_ID = "kink-extractor";

const defaultSettings = {
    lastResult: "",
    isAdultConfirmed: false,
};

let extension_settings, getContext, generateRaw, saveSettingsDebounced;

// 알려진 이슈: 정적 import가 조용히 실패하는 경우가 있어 동적 import + window 폴백을 사용
async function loadModules() {
    try {
        const extMod = await import("../../../extensions.js");
        extension_settings = extMod.extension_settings ?? window.extension_settings;
        getContext = extMod.getContext ?? window.getContext ?? window.SillyTavern?.getContext;
    } catch (e) {
        extension_settings = window.extension_settings;
        getContext = window.getContext ?? window.SillyTavern?.getContext;
    }

    try {
        const scriptMod = await import("../../../../script.js");
        generateRaw = scriptMod.generateRaw ?? window.generateRaw;
        saveSettingsDebounced = scriptMod.saveSettingsDebounced ?? window.saveSettingsDebounced;
    } catch (e) {
        generateRaw = window.generateRaw;
        saveSettingsDebounced = window.saveSettingsDebounced;
    }

    if (!extension_settings || !getContext || !generateRaw) {
        console.error(`[${EXT_ID}] 필수 ST 모듈을 불러오지 못했습니다.`);
        return false;
    }
    return true;
}

function ensureSettings() {
    if (!extension_settings[EXT_ID]) {
        extension_settings[EXT_ID] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[EXT_ID][key] === undefined) {
            extension_settings[EXT_ID][key] = defaultSettings[key];
        }
    }
    return extension_settings[EXT_ID];
}

function getCurrentCharSheet() {
    const context = getContext();
    const char = context.characters?.[context.characterId];
    if (!char) return null;

    return {
        name: char.name || "",
        description: char.description || "",
        personality: char.personality || "",
        scenario: char.scenario || "",
        mes_example: char.mes_example || "",
    };
}

function buildPrompt(sheet, mode, previousResult) {
    const charName = sheet.name || "이 캐릭터";
    const base = `너는 성인 롤플레이 캐릭터 시트를 분석하는 어시스턴트야. 아래 캐릭터 시트를 읽고, ${charName}에게서 드러나는 성적 취향/킨크를 정리해줘.
이 작업은 명시적으로 성인(만 18세 이상) 캐릭터에 한정된다는 전제 하에 진행돼.

출력은 반드시 아래 형식의 마크다운 텍스트로만 작성해. 각 항목은 "kink"와 "근거" 두 줄이 한 쌍이고, 둘 다 완결된 문장의 줄글로 서술해:

## 캐시트 기반 (명시됨)
kink: [어떤 킨크/취향인지 자연스러운 문장으로 서술]
근거: [시트의 어느 부분에서 그렇게 판단했는지 자연스러운 문장으로 서술]

kink: ...
근거: ...

## AI 추천 (확장)
kink: [어떤 킨크/취향인지 자연스러운 문장으로 서술]
근거: [캐릭터 설정과 왜 어울리는지 자연스러운 문장으로 서술]

각 섹션에 항목을 3~6개 작성해. 하이픈(-)이나 리스트 기호는 쓰지 말고, "kink:"와 "근거:" 라벨만 사용해. JSON이나 코드블록 없이 순수 텍스트로만 출력해.

--- 캐릭터 시트 ---
이름: ${sheet.name}
설명: ${sheet.description}
성격: ${sheet.personality}
시나리오: ${sheet.scenario}
대화 예시: ${sheet.mes_example}
--- 끝 ---`;

    if (mode === "more" && previousResult) {
        return `${base}

이전에 이미 아래 항목들을 제시했어. 이번에는 겹치지 않는 새로운 항목으로 다시 만들어줘:

${previousResult}`;
    }

    return base;
}

function escapeHtml(text) {
    return $("<div>").text(text).html();
}

function renderResult(text) {
    const $out = $("#kink-extractor-result");
    if (!text) {
        $out.html('<div class="kink-extractor-placeholder">아직 분석 결과가 없어요.</div>');
        return;
    }

    const lines = text.split("\n");
    let html = "";
    let itemOpen = false;

    for (const rawLine of lines) {
        const line = rawLine.trim();

        if (!line) continue;

        if (line.startsWith("##")) {
            if (itemOpen) { html += "</div>"; itemOpen = false; }
            html += `<div class="section-title">${escapeHtml(line.replace(/^##\s*/, ""))}</div>`;
            continue;
        }

        const labelMatch = line.match(/^(kink|근거)\s*[:：]\s*(.*)$/i);
        if (labelMatch) {
            const [, rawLabel, rest] = labelMatch;
            const label = rawLabel.toLowerCase() === "kink" ? "kink" : "근거";
            if (label === "kink") {
                if (itemOpen) html += "</div>";
                html += '<div class="kink-item">';
                itemOpen = true;
            }
            html += `<p class="prose-line"><span class="field-label">${escapeHtml(label)}:</span> ${escapeHtml(rest)}</p>`;
            continue;
        }

        // 라벨이 안 붙은 일반 줄글은 그대로 출력
        html += `<p class="prose-line">${escapeHtml(line)}</p>`;
    }

    if (itemOpen) html += "</div>";

    $out.html(html || `<pre class="kink-extractor-text">${escapeHtml(text)}</pre>`);
}

async function runAnalysis(mode) {
    const settings = ensureSettings();

    if (!settings.isAdultConfirmed) {
        toastr?.warning?.("먼저 '이 캐릭터는 성인입니다'를 체크해줘.") ?? alert("먼저 '이 캐릭터는 성인입니다'를 체크해줘.");
        return;
    }

    const sheet = getCurrentCharSheet();
    if (!sheet) {
        toastr?.warning?.("선택된 캐릭터가 없어.") ?? alert("선택된 캐릭터가 없어.");
        return;
    }

    const $btn = mode === "more" ? $("#kink-extractor-more") : $("#kink-extractor-analyze");
    const originalText = $btn.text();
    $btn.prop("disabled", true).text("분석 중...");

    try {
        const prompt = buildPrompt(sheet, mode, settings.lastResult);
        const result = await generateRaw(prompt);
        const finalText = mode === "more" && settings.lastResult
            ? `${settings.lastResult}\n\n---\n\n${result}`
            : result;

        settings.lastResult = finalText;
        saveSettingsDebounced?.();
        renderResult(finalText);
    } catch (e) {
        console.error(`[${EXT_ID}] 분석 실패`, e);
        toastr?.error?.("분석 중 오류가 발생했어. 콘솔을 확인해줘.") ?? alert("분석 중 오류가 발생했어.");
    } finally {
        $btn.prop("disabled", false).text(originalText);
    }
}

function buildPanel() {
    const html = `
    <div id="kink-extractor-panel" class="kink-extractor-panel">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>킨크 추출기</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="kink-extractor-adult-confirm">
                    <input id="kink-extractor-adult-confirm" type="checkbox">
                    <span>이 캐릭터는 성인(만 18세 이상)입니다</span>
                </label>
                <div class="kink-extractor-buttons">
                    <button id="kink-extractor-analyze" class="menu_button">분석하기</button>
                    <button id="kink-extractor-more" class="menu_button">추천 더 받기</button>
                </div>
                <div id="kink-extractor-result" class="kink-extractor-result"></div>
            </div>
        </div>
    </div>`;

    $("#extensions_settings2").append(html);

    $("#kink-extractor-adult-confirm").on("change", function () {
        const settings = ensureSettings();
        settings.isAdultConfirmed = $(this).is(":checked");
        saveSettingsDebounced?.();
    });

    $("#kink-extractor-analyze").on("click", () => runAnalysis("analyze"));
    $("#kink-extractor-more").on("click", () => runAnalysis("more"));
}

jQuery(async () => {
    const ok = await loadModules();
    if (!ok) return;

    const settings = ensureSettings();
    buildPanel();
    $("#kink-extractor-adult-confirm").prop("checked", !!settings.isAdultConfirmed);
    renderResult(settings.lastResult);
});
