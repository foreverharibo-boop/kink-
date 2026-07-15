// 킨크 추출기 - CharSheet 기반 킨크 추출 + AI 추천 (텍스트 출력, 캐릭터별 저장, 마법봉 메뉴 진입)
// 결과는 items 배열([{section, kink, reason}])로 구조화해서 저장 -> 개별 리롤 / 검색 필터 / 복사 지원
const EXT_ID = "kink-extractor";

const SECTION_EXPLICIT = "explicit";
const SECTION_CHAT = "chat";
const SECTION_INFERRED = "inferred";
const SECTION_TITLES = {
    [SECTION_EXPLICIT]: "From Character Sheet (Explicit)",
    [SECTION_CHAT]: "From Recent Chat (Observed)",
    [SECTION_INFERRED]: "AI-Inferred (Expanded)",
};
const SECTION_ORDER = [SECTION_EXPLICIT, SECTION_CHAT, SECTION_INFERRED];

const defaultSettings = {
    perCharacter: {}, // key: 캐릭터 고유 키 -> { isAdultConfirmed, items: [{section, kink, reason}] }
    chatMessageCount: 0, // 분석에 반영할 최근 채팅 메시지 개수 (0 = 반영 안 함), 전역 설정
};

let extension_settings, getContext, generateRaw, saveSettingsDebounced;
let selectedCharIndex = null;
let searchTerm = "";

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
    if (typeof extension_settings[EXT_ID].chatMessageCount !== "number") {
        extension_settings[EXT_ID].chatMessageCount = 0;
    }
    return extension_settings[EXT_ID];
}

function getAllCharacters() {
    const context = getContext();
    return context.characters || [];
}

function getCharacterKeyByIndex(idx) {
    const chars = getAllCharacters();
    const char = chars[idx];
    if (!char) return null;
    return char.avatar || char.name || String(idx);
}

function getEntryByIndex(idx) {
    const settings = ensureSettings();
    const key = getCharacterKeyByIndex(idx);
    if (!key) return null;
    if (!settings.perCharacter[key]) {
        settings.perCharacter[key] = { isAdultConfirmed: false, items: [] };
    }
    const entry = settings.perCharacter[key];

    // 구버전(lastResult 텍스트 블롭) 데이터가 남아있으면 items 배열로 자동 마이그레이션 - 스키마 변경 때문에 데이터가 날아가지 않도록
    if ((!entry.items || !entry.items.length) && typeof entry.lastResult === "string" && entry.lastResult.trim()) {
        entry.items = parseItemsFromText(entry.lastResult);
        delete entry.lastResult;
        saveSettingsDebounced?.();
    }
    if (!entry.items) entry.items = [];

    return entry;
}

function getSheetByIndex(idx) {
    const chars = getAllCharacters();
    const char = chars[idx];
    if (!char) return null;

    return {
        name: char.name || "",
        description: char.description || "",
        personality: char.personality || "",
        scenario: char.scenario || "",
        mes_example: char.mes_example || "",
    };
}

// 최근 채팅 로그는 "현재 실제로 열려있는 채팅"에서만 읽을 수 있음 (드롭다운으로 다른 캐릭터를 봐도 그 캐릭터의 채팅 로그엔 접근 불가)
function isSelectedCharacterActiveChat(idx) {
    const context = getContext();
    return context.characterId !== undefined && Number(context.characterId) === Number(idx);
}

function getRecentChatText(idx, count) {
    if (!count || count <= 0) return null;
    if (!isSelectedCharacterActiveChat(idx)) return null;

    const context = getContext();
    const chat = context.chat || [];
    const recent = chat.slice(-count);

    if (!recent.length) return null;

    return recent
        .map((m) => `${m.name}: ${(m.mes || "").replace(/\s+/g, " ").trim()}`)
        .join("\n");
}

// ---------- 파싱/직렬화 ----------

// AI 응답 텍스트(섹션 헤더 + Kink/Reason 쌍)를 items 배열로 파싱
function parseItemsFromText(text) {
    const lines = text.split("\n");
    let currentSection = SECTION_EXPLICIT;
    const items = [];

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith("##")) {
            const headerText = line.replace(/^##\s*/, "").toLowerCase();
            if (headerText.includes("chat")) {
                currentSection = SECTION_CHAT;
            } else if (headerText.includes("infer")) {
                currentSection = SECTION_INFERRED;
            } else {
                currentSection = SECTION_EXPLICIT;
            }
            continue;
        }

        const kinkMatch = line.match(/^kink\s*[:：]\s*(.*)$/i);
        if (kinkMatch) {
            items.push({ section: currentSection, kink: kinkMatch[1], reason: "" });
            continue;
        }

        const reasonMatch = line.match(/^reason\s*[:：]\s*(.*)$/i);
        if (reasonMatch && items.length) {
            items[items.length - 1].reason = reasonMatch[1];
        }
    }

    return items;
}

// items 배열을 다시 AI 프롬프트/복사용 텍스트로 직렬화
function serializeItems(items) {
    let out = "";
    for (const sectionKey of SECTION_ORDER) {
        const group = items.filter((it) => it.section === sectionKey);
        if (!group.length) continue;
        out += `## ${SECTION_TITLES[sectionKey]}\n`;
        for (const it of group) {
            out += `Kink: ${it.kink}\nReason: ${it.reason}\n\n`;
        }
    }
    return out.trim();
}

// ---------- 프롬프트 ----------

function sheetBlock(sheet) {
    return `--- Character Sheet ---
Name: ${sheet.name}
Description: ${sheet.description}
Personality: ${sheet.personality}
Scenario: ${sheet.scenario}
Example dialogue: ${sheet.mes_example}
--- End ---`;
}

function commonInstructions(charName) {
    return `You are an assistant that analyzes adult roleplay character sheets. This task is strictly limited to characters who are adults (18+ years old).
State everything as a fact the character already possesses — never phrase it as a suggestion, proposal, or recommendation. Do NOT use words like "suggest", "recommend", "propose". Always phrase the Kink line so it ends with a statement of possession (e.g. "${charName} has a strong desire for ...", "${charName} possesses a kink for ...").`;
}

function chatBlock(chatText) {
    if (!chatText) return "";
    return `\n\n--- Recent Chat Log (most recent ${chatText.split("\n").length} messages) ---\n${chatText}\n--- End Chat Log ---`;
}

function buildFullPrompt(sheet, chatText) {
    const charName = sheet.name || "this character";
    const chatSection = chatText
        ? `\n\n## From Recent Chat (Observed)\nKink: [a natural sentence stating a kink/preference ${charName} demonstrates in the recent chat log]\nReason: [a natural sentence pointing to what happened in the chat log that shows this]\n\nKink: ...\nReason: ...\n`
        : "";
    const chatNote = chatText
        ? ` You are also given a recent chat log below — use it as a third source: identify kinks actually demonstrated in that dialogue, separate from what's merely stated in the character sheet.`
        : "";

    return `${commonInstructions(charName)}${chatNote}

Respond ONLY in English, in the exact plain-text format below. Each entry is a pair of "Kink" and "Reason" lines, written as complete, natural sentences.

## From Character Sheet (Explicit)
Kink: [a natural sentence stating the kink/preference ${charName} has]
Reason: [a natural sentence explaining which part of the sheet supports this]

Kink: ...
Reason: ...
${chatSection}
## AI-Inferred (Expanded)
Kink: [a natural sentence stating a kink/preference ${charName} has]
Reason: [a natural sentence explaining why it fits the character's established traits]

Write 3 to 6 entries per section. Do not use hyphens or bullet symbols, only the "Kink:" and "Reason:" labels. Output plain text only, no JSON, no code blocks.

${sheetBlock(sheet)}${chatBlock(chatText)}`;
}

function buildMorePrompt(sheet, existingItems, chatText) {
    const existingText = serializeItems(existingItems);
    return `${buildFullPrompt(sheet, chatText)}

You already produced the following entries earlier. This time, produce new entries that do not overlap with them:

${existingText}`;
}

function buildSingleRerollPrompt(sheet, section, existingItems, chatText) {
    const charName = sheet.name || "this character";
    const existingText = serializeItems(existingItems);
    const sectionLabel = SECTION_TITLES[section];
    const relevantChatBlock = section === SECTION_CHAT ? chatBlock(chatText) : "";
    return `${commonInstructions(charName)}

Produce exactly ONE new entry for the category "${sectionLabel}" that is different from all entries listed below. Respond ONLY in English with exactly these two lines and nothing else:

Kink: [a natural sentence stating the kink/preference ${charName} has]
Reason: [a natural sentence explaining the basis for it]

Existing entries to avoid duplicating:
${existingText}

${sheetBlock(sheet)}${relevantChatBlock}`;
}

// ---------- 렌더링 ----------

function escapeHtml(text) {
    return $("<div>").text(text).html();
}

function itemMatchesSearch(item, term) {
    if (!term) return true;
    const haystack = `${item.kink} ${item.reason}`.toLowerCase();
    return haystack.includes(term.toLowerCase());
}

function renderResult(items) {
    const $out = $("#kink-extractor-result");

    if (!items || !items.length) {
        $out.html('<div class="kink-extractor-placeholder">No analysis yet.</div>');
        return;
    }

    let html = "";
    let anyVisible = false;

    for (const sectionKey of SECTION_ORDER) {
        const group = items
            .map((it, idx) => ({ ...it, idx }))
            .filter((it) => it.section === sectionKey);
        if (!group.length) continue;

        const visibleGroup = group.filter((it) => itemMatchesSearch(it, searchTerm));
        if (!visibleGroup.length) continue;

        anyVisible = true;
        html += `<div class="section-title">${escapeHtml(SECTION_TITLES[sectionKey])}</div>`;
        for (const it of visibleGroup) {
            html += `
            <div class="kink-item" data-idx="${it.idx}">
                <p class="prose-line"><span class="field-label">Kink:</span> ${escapeHtml(it.kink)}</p>
                <p class="prose-line"><span class="field-label">Reason:</span> ${escapeHtml(it.reason)}</p>
                <div class="kink-item-actions">
                    <button class="kink-reroll-btn" data-idx="${it.idx}" title="Reroll this entry">🔁 Reroll</button>
                    <button class="kink-copy-btn" data-idx="${it.idx}" title="Copy just the Kink line">📋 Copy Kink</button>
                </div>
            </div>`;
        }
    }

    if (!anyVisible) {
        $out.html('<div class="kink-extractor-placeholder">No entries match your search.</div>');
        return;
    }

    $out.html(html);

    $out.find(".kink-reroll-btn").on("click", function () {
        const idx = Number($(this).data("idx"));
        rerollItem(idx);
    });

    $out.find(".kink-copy-btn").on("click", function () {
        const idx = Number($(this).data("idx"));
        copyKinkOnly(idx, $(this));
    });
}

// ---------- 액션 ----------

async function runFullAnalysis(mode) {
    if (selectedCharIndex === null) {
        toastr?.warning?.("No character selected.") ?? alert("No character selected.");
        return;
    }

    const entry = getEntryByIndex(selectedCharIndex);
    if (!entry) return;

    if (!entry.isAdultConfirmed) {
        toastr?.warning?.("Please check 'This character is an adult' first.") ?? alert("Please check 'This character is an adult' first.");
        return;
    }

    const sheet = getSheetByIndex(selectedCharIndex);
    if (!sheet) return;

    const settings = ensureSettings();
    const chatText = getRecentChatText(selectedCharIndex, settings.chatMessageCount);

    const $btn = mode === "more" ? $("#kink-extractor-more") : $("#kink-extractor-analyze");
    const originalText = $btn.text();
    $btn.prop("disabled", true).text("Working...");

    try {
        const prompt = mode === "more" && entry.items.length
            ? buildMorePrompt(sheet, entry.items, chatText)
            : buildFullPrompt(sheet, chatText);

        const result = await generateRaw(prompt);
        const newItems = parseItemsFromText(result);

        entry.items = mode === "more" ? [...entry.items, ...newItems] : newItems;
        saveSettingsDebounced?.();
        renderResult(entry.items);
    } catch (e) {
        console.error(`[${EXT_ID}] 분석 실패`, e);
        toastr?.error?.("An error occurred during analysis. Check the console.") ?? alert("An error occurred during analysis.");
    } finally {
        $btn.prop("disabled", false).text(originalText);
    }
}

async function rerollItem(idx) {
    if (selectedCharIndex === null) return;
    const entry = getEntryByIndex(selectedCharIndex);
    if (!entry || !entry.items[idx]) return;

    const sheet = getSheetByIndex(selectedCharIndex);
    if (!sheet) return;

    const settings = ensureSettings();
    const chatText = getRecentChatText(selectedCharIndex, settings.chatMessageCount);

    const $item = $(`.kink-item[data-idx="${idx}"]`);
    const $btn = $item.find(".kink-reroll-btn");
    $btn.prop("disabled", true).text("Rerolling...");

    try {
        const originalSection = entry.items[idx].section;
        const prompt = buildSingleRerollPrompt(sheet, originalSection, entry.items, chatText);
        const result = await generateRaw(prompt);
        const parsed = parseItemsFromText(result);

        if (parsed.length) {
            entry.items[idx] = { section: originalSection, kink: parsed[0].kink, reason: parsed[0].reason };
            saveSettingsDebounced?.();
            renderResult(entry.items);
        } else {
            toastr?.warning?.("Could not parse the reroll result.") ?? alert("Could not parse the reroll result.");
            $btn.prop("disabled", false).text("🔁 Reroll");
        }
    } catch (e) {
        console.error(`[${EXT_ID}] 리롤 실패`, e);
        toastr?.error?.("Reroll failed. Check the console.") ?? alert("Reroll failed.");
        $btn.prop("disabled", false).text("🔁 Reroll");
    }
}

function copyKinkOnly(idx, $btn) {
    if (selectedCharIndex === null) return;
    const entry = getEntryByIndex(selectedCharIndex);
    if (!entry || !entry.items[idx]) return;

    const text = entry.items[idx].kink;
    const originalText = $btn.text();

    const onSuccess = () => {
        $btn.text("Copied!");
        setTimeout(() => $btn.text(originalText), 1200);
    };
    const onFail = () => {
        toastr?.error?.("Copy failed - please copy manually.") ?? alert("Copy failed - please copy manually.");
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(onSuccess).catch(() => {
            legacyCopy(text) ? onSuccess() : onFail();
        });
    } else {
        legacyCopy(text) ? onSuccess() : onFail();
    }
}

function copyResultToClipboard() {
    if (selectedCharIndex === null) return;
    const entry = getEntryByIndex(selectedCharIndex);
    if (!entry || !entry.items.length) {
        toastr?.info?.("Nothing to copy yet.") ?? alert("Nothing to copy yet.");
        return;
    }

    const text = serializeItems(entry.items);
    const $btn = $("#kink-extractor-copy");
    const originalText = $btn.text();

    const onSuccess = () => {
        $btn.text("Copied!");
        setTimeout(() => $btn.text(originalText), 1200);
    };
    const onFail = () => {
        toastr?.error?.("Copy failed - please copy manually.") ?? alert("Copy failed - please copy manually.");
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(onSuccess).catch(() => {
            legacyCopy(text) ? onSuccess() : onFail();
        });
    } else {
        legacyCopy(text) ? onSuccess() : onFail();
    }
}

// 구형 웹뷰(Samsung Internet PWA 등) 대비 execCommand 폴백
function legacyCopy(text) {
    try {
        const $temp = $("<textarea>").val(text).css({ position: "fixed", opacity: 0 });
        $("body").append($temp);
        $temp[0].select();
        const ok = document.execCommand("copy");
        $temp.remove();
        return ok;
    } catch (e) {
        return false;
    }
}

// ---------- 팝업/UI ----------

function populateCharacterSelect() {
    const context = getContext();
    const chars = getAllCharacters();
    const $select = $("#kink-extractor-char-select");
    $select.empty();

    chars.forEach((char, idx) => {
        $select.append(`<option value="${idx}">${escapeHtml(char.name || "(unnamed)")}</option>`);
    });

    const defaultIdx = context.characterId !== undefined && chars[context.characterId] ? context.characterId : 0;
    selectedCharIndex = chars.length ? defaultIdx : null;
    $select.val(selectedCharIndex);
}

function updateChatNote() {
    const settings = ensureSettings();
    const $note = $("#kink-extractor-chat-note");
    if (!settings.chatMessageCount || settings.chatMessageCount <= 0) {
        $note.text("");
        return;
    }
    if (selectedCharIndex !== null && isSelectedCharacterActiveChat(selectedCharIndex)) {
        $note.text(`Will include the last ${settings.chatMessageCount} messages from the currently open chat.`);
    } else {
        $note.text("This character's chat isn't currently open, so chat messages can't be included right now.");
    }
}

function refreshPopupForSelectedCharacter() {
    searchTerm = "";
    $("#kink-extractor-search").val("");

    const settings = ensureSettings();
    $("#kink-extractor-chat-count").val(settings.chatMessageCount);
    updateChatNote();

    if (selectedCharIndex === null) {
        $("#kink-extractor-adult-confirm").prop("checked", false);
        renderResult([]);
        return;
    }
    const entry = getEntryByIndex(selectedCharIndex);
    $("#kink-extractor-adult-confirm").prop("checked", !!entry?.isAdultConfirmed);
    renderResult(entry?.items || []);
}

function buildPopup() {
    if ($("#kink-extractor-overlay").length) return;

    const html = `
    <div id="kink-extractor-overlay" class="kink-extractor-overlay">
        <div id="kink-extractor-popup" class="kink-extractor-popup">
            <div class="kink-extractor-popup-header">
                <span class="kink-extractor-title">Kink Extractor</span>
                <span id="kink-extractor-close" class="kink-extractor-close">✕</span>
            </div>
            <div class="kink-extractor-popup-body">
                <div class="kink-extractor-char-select-wrap">
                    <label class="kink-extractor-label">Character</label>
                    <select id="kink-extractor-char-select" class="kink-extractor-char-select"></select>
                </div>

                <label class="checkbox_label" for="kink-extractor-adult-confirm">
                    <input id="kink-extractor-adult-confirm" type="checkbox">
                    <span>This character is an adult (18+)</span>
                </label>

                <div class="kink-extractor-chat-count-wrap">
                    <label class="kink-extractor-label" for="kink-extractor-chat-count">Recent chat messages to include</label>
                    <input id="kink-extractor-chat-count" class="kink-extractor-chat-count" type="number" min="0" max="50" step="1">
                    <div id="kink-extractor-chat-note" class="kink-extractor-chat-note"></div>
                </div>

                <div class="kink-extractor-buttons">
                    <button id="kink-extractor-analyze" class="menu_button primary">Analyze</button>
                    <button id="kink-extractor-more" class="menu_button">More suggestions</button>
                </div>

                <div class="kink-extractor-result-header">
                    <input id="kink-extractor-search" class="kink-extractor-search" type="text" placeholder="Search results...">
                    <button id="kink-extractor-copy" class="kink-extractor-copy-btn" title="Copy all results">Copy</button>
                </div>

                <div id="kink-extractor-result" class="kink-extractor-result"></div>
                <div class="kink-extractor-footnote">Saved automatically per character on this device's server settings.</div>
            </div>
        </div>
    </div>`;

    // MovingUI의 body transform 때문에 position:fixed가 깨지는 문제 회피 -> documentElement에 부착
    $(document.documentElement).append(html);

    $("#kink-extractor-char-select").on("change", function () {
        selectedCharIndex = Number($(this).val());
        refreshPopupForSelectedCharacter();
    });

    $("#kink-extractor-adult-confirm").on("change", function () {
        if (selectedCharIndex === null) return;
        const entry = getEntryByIndex(selectedCharIndex);
        if (!entry) return;
        entry.isAdultConfirmed = $(this).is(":checked");
        saveSettingsDebounced?.();
    });

    $("#kink-extractor-chat-count").on("change input", function () {
        const settings = ensureSettings();
        const val = Math.max(0, Math.min(50, Number($(this).val()) || 0));
        settings.chatMessageCount = val;
        saveSettingsDebounced?.();
        updateChatNote();
    });

    $("#kink-extractor-analyze").on("click", () => runFullAnalysis("analyze"));
    $("#kink-extractor-more").on("click", () => runFullAnalysis("more"));
    $("#kink-extractor-copy").on("click", copyResultToClipboard);

    $("#kink-extractor-search").on("input", function () {
        searchTerm = $(this).val();
        if (selectedCharIndex === null) return;
        const entry = getEntryByIndex(selectedCharIndex);
        renderResult(entry?.items || []);
    });

    $("#kink-extractor-close").on("click", closePopup);
    $("#kink-extractor-overlay").on("click", function (e) {
        if (e.target.id === "kink-extractor-overlay") closePopup();
    });
}

function openPopup() {
    buildPopup();
    populateCharacterSelect();
    refreshPopupForSelectedCharacter();

    const $wandMenu = $("#extensionsMenu");
    if ($wandMenu.length && $wandMenu.is(":visible")) {
        $wandMenu.data("kink-extractor-was-open", true).hide();
    }

    $("#kink-extractor-overlay").addClass("open");
}

function closePopup() {
    $("#kink-extractor-overlay").removeClass("open");

    const $wandMenu = $("#extensionsMenu");
    if ($wandMenu.data("kink-extractor-was-open")) {
        $wandMenu.removeData("kink-extractor-was-open").show();
    }
}

function addWandButton() {
    const buttonHtml = `
    <div id="kink-extractor-wand-button" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
        <div class="fa-solid fa-wand-magic-sparkles extensionsMenuExtensionButton"></div>
        <span>Kink Extractor</span>
    </div>`;

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
