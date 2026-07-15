// 킨크 추출기 - CharSheet 기반 킨크 추출 + AI 추천 (텍스트 출력, 캐릭터별 저장, 마법봉 메뉴 진입)
const EXT_ID = "kink-extractor";

const defaultSettings = {
    perCharacter: {}, // key: 캐릭터 고유 키 -> { isAdultConfirmed, lastResult }
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
    if (!extension_settings[EXT_ID].perCharacter) {
        extension_settings[EXT_ID].perCharacter = {};
    }
    return extension_settings[EXT_ID];
}

// 캐릭터별로 결과/체크박스를 분리 저장하기 위한 고유 키
function getCharacterKey() {
    const context = getContext();
    const char = context.characters?.[context.characterId];
    if (!char) return null;
    return char.avatar || char.name || String(context.characterId);
}

function getCharEntry() {
    const settings = ensureSettings();
    const key = getCharacterKey();
    if (!key) return null;
    if (!settings.perCharacter[key]) {
        settings.perCharacter[key] = { isAdultConfirmed: false, lastResult: "" };
    }
    return settings.perCharacter[key];
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
    const charName = sheet.name || "this character";
    const base = `You are an assistant that analyzes adult roleplay character sheets. Read the character sheet below and identify the sexual kinks/preferences ${charName} possesses.
This task is strictly limited to characters who are adults (18+ years old).

Respond ONLY in English, in the exact plain-text format below. Each entry is a pair of "Kink" and "Reason" lines, written as complete, natural sentences. State everything as a fact the character already possesses — never phrase it as a suggestion, proposal, or recommendation. Do NOT use words like "suggest", "recommend", "propose". Always phrase the Kink line so it ends with a statement of possession (e.g. "${charName} has a strong desire for ...", "${charName} possesses a kink for ...").

## From Character Sheet (Explicit)
Kink: [a natural sentence stating the kink/preference ${charName} has]
Reason: [a natural sentence explaining which part of the sheet supports this]

Kink: ...
Reason: ...

## AI-Inferred (Expanded)
Kink: [a natural sentence stating a kink/preference ${charName} has]
Reason: [a natural sentence explaining why it fits the character's established traits]

Write 3 to 6 entries per section. Do not use hyphens or bullet symbols, only the "Kink:" and "Reason:" labels. Output plain text only, no JSON, no code blocks.

--- Character Sheet ---
Name: ${sheet.name}
Description: ${sheet.description}
Personality: ${sheet.personality}
Scenario: ${sheet.scenario}
Example dialogue: ${sheet.mes_example}
--- End ---`;

    if (mode === "more" && previousResult) {
        return `${base}

You already produced the following entries earlier. This time, produce new entries that do not overlap with them:

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
        $out.html('<div class="kink-extractor-placeholder">No analysis yet.</div>');
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

        const labelMatch = line.match(/^(kink|reason)\s*[:：]\s*(.*)$/i);
        if (labelMatch) {
            const [, rawLabel, rest] = labelMatch;
            const label = rawLabel.toLowerCase() === "kink" ? "Kink" : "Reason";
            if (label === "Kink") {
                if (itemOpen) html += "</div>";
                html += '<div class="kink-item">';
                itemOpen = true;
            }
            html += `<p class="prose-line"><span class="field-label">${label}:</span> ${escapeHtml(rest)}</p>`;
            continue;
        }

        html += `<p class="prose-line">${escapeHtml(line)}</p>`;
    }

    if (itemOpen) html += "</div>";

    $out.html(html || `<pre class="kink-extractor-text">${escapeHtml(text)}</pre>`);
}

async function runAnalysis(mode) {
    const entry = getCharEntry();
    if (!entry) {
        toastr?.warning?.("No character selected.") ?? alert("No character selected.");
        return;
    }

    if (!entry.isAdultConfirmed) {
        toastr?.warning?.("Please check 'This character is an adult' first.") ?? alert("Please check 'This character is an adult' first.");
        return;
    }

    const sheet = getCurrentCharSheet();
    if (!sheet) {
        toastr?.warning?.("No character selected.") ?? alert("No character selected.");
        return;
    }

    const $btn = mode === "more" ? $("#kink-extractor-more") : $("#kink-extractor-analyze");
    const originalText = $btn.text();
    $btn.prop("disabled", true).text("Analyzing...");

    try {
        const prompt = buildPrompt(sheet, mode, entry.lastResult);
        const result = await generateRaw(prompt);
        const finalText = mode === "more" && entry.lastResult
            ? `${entry.lastResult}\n\n---\n\n${result}`
            : result;

        entry.lastResult = finalText;
        saveSettingsDebounced?.();
        renderResult(finalText);
    } catch (e) {
        console.error(`[${EXT_ID}] 분석 실패`, e);
        toastr?.error?.("An error occurred during analysis. Check the console.") ?? alert("An error occurred during analysis.");
    } finally {
        $btn.prop("disabled", false).text(originalText);
    }
}

function refreshPopupForCurrentCharacter() {
    const entry = getCharEntry();
    const context = getContext();
    const char = context.characters?.[context.characterId];

    $("#kink-extractor-char-name").text(char?.name || "No character selected");
    $("#kink-extractor-adult-confirm").prop("checked", !!entry?.isAdultConfirmed);
    renderResult(entry?.lastResult || "");
}

function buildPopup() {
    if ($("#kink-extractor-overlay").length) return;

    const html = `
    <div id="kink-extractor-overlay" class="kink-extractor-overlay">
        <div id="kink-extractor-popup" class="kink-extractor-popup">
            <div class="kink-extractor-popup-header">
                <b>Kink Extractor</b>
                <span id="kink-extractor-close" class="kink-extractor-close">✕</span>
            </div>
            <div class="kink-extractor-popup-body">
                <div id="kink-extractor-char-name" class="kink-extractor-char-name"></div>
                <label class="checkbox_label" for="kink-extractor-adult-confirm">
                    <input id="kink-extractor-adult-confirm" type="checkbox">
                    <span>This character is an adult (18+)</span>
                </label>
                <div class="kink-extractor-buttons">
                    <button id="kink-extractor-analyze" class="menu_button">Analyze</button>
                    <button id="kink-extractor-more" class="menu_button">More suggestions</button>
                </div>
                <div id="kink-extractor-result" class="kink-extractor-result"></div>
            </div>
        </div>
    </div>`;

    // MovingUI의 body transform 때문에 position:fixed가 깨지는 문제 회피 -> documentElement에 부착
    $(document.documentElement).append(html);

    $("#kink-extractor-adult-confirm").on("change", function () {
        const entry = getCharEntry();
        if (!entry) return;
        entry.isAdultConfirmed = $(this).is(":checked");
        saveSettingsDebounced?.();
    });

    $("#kink-extractor-analyze").on("click", () => runAnalysis("analyze"));
    $("#kink-extractor-more").on("click", () => runAnalysis("more"));

    $("#kink-extractor-close").on("click", closePopup);
    $("#kink-extractor-overlay").on("click", function (e) {
        if (e.target.id === "kink-extractor-overlay") closePopup();
    });
}

function openPopup() {
    buildPopup();
    refreshPopupForCurrentCharacter();
    $("#kink-extractor-overlay").addClass("open");
}

function closePopup() {
    $("#kink-extractor-overlay").removeClass("open");
}

function addWandButton() {
    const buttonHtml = `
    <div id="kink-extractor-wand-button" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
        <div class="fa-solid fa-wand-magic-sparkles extensionsMenuExtensionButton"></div>
        <span>Kink Extractor</span>
    </div>`;

    // ST 마법봉(확장 메뉴) 팝업에 버튼 추가
    const $menu = $("#extensionsMenu");
    if ($menu.length) {
        $menu.append(buttonHtml);
        $("#kink-extractor-wand-button").on("click", () => {
            openPopup();
        });
    } else {
        console.warn(`[${EXT_ID}] #extensionsMenu를 찾지 못했어 - ST 버전에 따라 셀렉터 조정이 필요할 수 있어.`);
    }
}

jQuery(async () => {
    const ok = await loadModules();
    if (!ok) return;

    ensureSettings();
    addWandButton();
});
