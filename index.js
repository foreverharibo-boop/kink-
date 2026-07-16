// 킨크 추출기 - CharSheet 기반 킨크 추출 + AI 추천 (텍스트 출력, 캐릭터별 저장, 마법봉 메뉴 진입)
// 결과는 items 배열([{section, kink, reason}])로 구조화해서 저장 -> 개별 리롤 / 검색 필터 / 복사 지원
const EXT_ID = "kink-extractor";

const SECTION_EXPLICIT = "explicit";
const SECTION_CHAT = "chat";
const SECTION_LOREBOOK = "lorebook";
const SECTION_INFERRED = "inferred";
const SECTION_TITLES = {
    [SECTION_EXPLICIT]: "From Character Sheet (Explicit)",
    [SECTION_CHAT]: "From Recent Chat (Observed)",
    [SECTION_LOREBOOK]: "From Lorebook (Observed)",
    [SECTION_INFERRED]: "AI-Inferred (Expanded)",
};
const SECTION_ORDER = [SECTION_EXPLICIT, SECTION_LOREBOOK, SECTION_CHAT, SECTION_INFERRED];

// 로어북 항목 중에 이런 키워드가 key/comment/content에 있으면 "킨크 관련"으로 보고 뽑아옴
const LOREBOOK_KEYWORDS = [
    // 기본
    "kink", "kinky", "fetish", "fetishes",
    "sex", "sexual", "sexuality", "sexually",
    "erotic", "erotica", "nsfw", "lewd", "obscene", "taboo",
    // 욕구/흥분
    "arousal", "aroused", "arouse", "horny", "lust", "lustful", "libido", "aphrodisiac",
    "desire", "desires", "carnal", "erogenous", "intimacy", "intimate",
    // BDSM/역할
    "bdsm", "dominant", "dominance", "domme", "dom", "submissive", "submission", "sub",
    "master", "mistress", "slave", "pet play", "petplay", "primal",
    // 구속/도구
    "bondage", "bound", "restraint", "restraints", "rope", "collar", "leash",
    "blindfold", "gag", "gagged", "handcuff", "handcuffs", "chain", "chains",
    // 행위/플레이 스타일
    "spank", "spanking", "choke", "choking", "breathplay", "breath play",
    "degradation", "degrade", "humiliation", "humiliate", "punishment", "punish",
    "orgasm", "climax", "foreplay", "seduce", "seduction", "seductive",
    "virgin", "deflower", "voyeur", "voyeurism", "exhibitionist", "exhibitionism",
    "masochist", "masochism", "sadist", "sadism", "tease", "teasing",
    "moan", "possessive", "jealous", "temptation", "tempt", "forbidden",
];

const defaultSettings = {
    perCharacter: {}, // key: 캐릭터 고유 키 -> { isAdultConfirmed, items: [{section, kink, reason}] }
    chatMessageCount: 0, // 분석에 반영할 최근 채팅 메시지 개수 (0 = 반영 안 함), 전역 설정
};

let extension_settings, getContext, generateRaw, saveSettingsDebounced, loadWorldInfo;
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

    // 로어북 읽기용 - getContext()를 통해 가져오는 게 가장 안전함
    try {
        loadWorldInfo = getContext?.()?.loadWorldInfo ?? window.loadWorldInfo;
    } catch (e) {
        loadWorldInfo = window.loadWorldInfo;
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

// ---------- CardInject 연동 ----------
// CardInject(foreverharibo-boop/cardinject)의 extension_settings 구조에 직접 써서
// "Kink" 카테고리에 항목을 추가함. 캐릭터 키 포맷을 CardInject 쪽과 반드시 맞춰야 함(idx_ 접두사).
const CARDINJECT_KEY = "cardinject";

function getCardInjectCharKey(idx) {
    const chars = getAllCharacters();
    const char = chars[idx];
    if (!char) return null;
    return char.avatar || char.name || `idx_${idx}`;
}

function ensureCardInjectCharStore(idx) {
    if (!extension_settings[CARDINJECT_KEY]) {
        extension_settings[CARDINJECT_KEY] = { perChar: {}, selectedCharIdx: null, lastCharId: null, activeKeys: [] };
    }
    const store = extension_settings[CARDINJECT_KEY];
    if (!store.perChar) store.perChar = {};

    const key = getCardInjectCharKey(idx);
    if (!key) return null;

    if (!store.perChar[key]) store.perChar[key] = { categories: [] };
    if (!Array.isArray(store.perChar[key].categories)) store.perChar[key].categories = [];
    return store.perChar[key];
}

// kinkText 한 줄을 CardInject의 "Sexuality & Kink" 카테고리에 추가 (없으면 새로 만듦, 중복 줄은 건너뜀)
// 이미 있는 카테고리 이름에 kink 또는 sexuality가 들어가 있으면 그걸 그대로 사용 (예: "Sexuality & Kink" 같은 기존 카테고리)
function addKinkToCardInject(idx, kinkText) {
    const charStore = ensureCardInjectCharStore(idx);
    if (!charStore) return "no-character";

    let kinkCat = charStore.categories.find((c) => {
        const name = (c.name || "").trim().toLowerCase();
        return name.includes("kink") || name.includes("sexuality") || name.includes("sexual");
    });
    if (!kinkCat) {
        kinkCat = {
            key: Math.random().toString(36).slice(2),
            name: "Sexuality & Kink",
            content: "",
            importance: "medium",
            position: "sys_top",
            customDepth: 0,
            enabled: true,
            expanded: false,
        };
        charStore.categories.push(kinkCat);
    }

    const existingLines = (kinkCat.content || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const trimmed = kinkText.trim();
    if (existingLines.includes(trimmed)) return "duplicate";

    kinkCat.content = [...existingLines, trimmed].join("\n");
    saveSettingsDebounced?.();
    return "added";
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

// 캐릭터 카드에 바인딩된 primary 로어북 이름 (없으면 null)
function getCharacterLorebookName(idx) {
    const chars = getAllCharacters();
    const char = chars[idx];
    if (!char) return null;
    return char.data?.extensions?.world || char.world || null;
}

// 챗 로어(그 채팅에만 연결된 로어북) 이름 - 채팅 로그와 마찬가지로 "지금 열려있는 채팅"일 때만 접근 가능
function getChatLorebookName(idx) {
    if (!isSelectedCharacterActiveChat(idx)) return null;
    const context = getContext();
    const meta = context.chatMetadata || {};

    // 챗 로어 필드명이 ST 버전마다 다를 수 있어서 여러 후보를 시도
    const candidates = [
        meta.world_info,
        meta.world,
        meta.chat_world_info,
        meta.chatLore,
        meta.chat_lore,
    ];

    for (const c of candidates) {
        if (typeof c === "string" && c.trim()) return c.trim();
    }

    // 위에서 못 찾으면 ST UI의 챗 로어 드롭다운 DOM에서 직접 읽기 (연결 프로필과 같은 패턴)
    try {
        const $chatLoreSelect = $("#chat_world_info, select[id*='chat'][id*='lore'], select[id*='chat'][id*='world']");
        if ($chatLoreSelect.length) {
            const val = $chatLoreSelect.val();
            if (val && val.trim()) return val.trim();
        }
    } catch (e) {
        console.warn(`[${EXT_ID}] 챗 로어 DOM 읽기 실패`, e);
    }

    return null;
}

// 캐릭터 로어 + 챗 로어를 모두 읽어서, key/comment/content에 킨크 관련 키워드가 있는 항목만 골라 텍스트로 합쳐줌
// 캐릭터 로어는 어떤 캐릭터를 골라도 읽을 수 있지만, 챗 로어는 지금 열려있는 채팅일 때만 읽을 수 있음
async function getLorebookKinkText(idx) {
    const charBookName = getCharacterLorebookName(idx);
    const chatBookName = getChatLorebookName(idx);
    // 같은 이름이면 중복으로 두 번 안 읽도록
    const bookNames = [...new Set([charBookName, chatBookName].filter(Boolean))];

    if (!bookNames.length) return { status: "no-book", text: null, bookNames: [] };

    const allMatched = [];
    const loadedBookNames = [];
    let anyLoadFailed = false;

    for (const bookName of bookNames) {
        let data;
        try {
            data = await loadWorldInfo(bookName);
        } catch (e) {
            console.error(`[${EXT_ID}] 로어북 로드 실패: ${bookName}`, e);
            anyLoadFailed = true;
            continue;
        }

        const entries = data?.entries ? Object.values(data.entries) : [];
        if (!entries.length) continue;

        loadedBookNames.push(bookName);
        const matched = entries.filter((entry) => {
            const haystack = [
                ...(Array.isArray(entry.key) ? entry.key : []),
                ...(Array.isArray(entry.keysecondary) ? entry.keysecondary : []),
                entry.comment || "",
                entry.content || "",
            ].join(" ").toLowerCase();
            return LOREBOOK_KEYWORDS.some((kw) => haystack.includes(kw));
        });

        allMatched.push(...matched);
    }

    if (!loadedBookNames.length && anyLoadFailed) {
        return { status: "load-failed", text: null, bookNames };
    }
    if (!allMatched.length) {
        return { status: "no-match", text: null, bookNames };
    }

    const text = allMatched
        .map((entry) => {
            const label = entry.comment || (Array.isArray(entry.key) ? entry.key.join(", ") : "") || "(untitled entry)";
            return `${label}: ${(entry.content || "").replace(/\s+/g, " ").trim()}`;
        })
        .join("\n");

    return { status: "ok", text, bookNames: loadedBookNames, count: allMatched.length };
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
            } else if (headerText.includes("lorebook") || headerText.includes("lore")) {
                currentSection = SECTION_LOREBOOK;
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

// 실제 ST 연결 프로필 <select> DOM을 직접 찾음 - 내부 데이터 구조를 추측하는 것보다 훨씬 안정적
function findProfileSelectEl() {
    const candidates = ["#connection_profiles", "select#connection_profiles"];
    for (const sel of candidates) {
        const $el = $(sel);
        if ($el.length) return $el;
    }
    return null;
}

// "분석용 프로필" 방식: 드롭다운에서 골라도 ST의 실제 연결은 그대로 유지되고 analysisProfileId에 저장만 됨.
// 분석 요청을 보내는 그 순간에만 잠깐 그 프로필로 전환했다가, 끝나면(성공/실패 상관없이) 원래 쓰던 프로필로 자동 복귀함.
async function generateWithSelectedProfile(prompt) {
    const settings = ensureSettings();
    const profileId = settings.analysisProfileId;

    if (!profileId) {
        return generateRaw(prompt);
    }

    const $select = findProfileSelectEl();
    if (!$select) {
        console.warn(`[${EXT_ID}] 연결 프로필 select를 찾지 못해 기본 연결로 진행해`);
        return generateRaw(prompt);
    }

    const originalValue = $select.val();
    const needsSwitch = originalValue !== profileId;

    try {
        if (needsSwitch) {
            $select.val(profileId).trigger("change");
            // ST가 프로필 전환을 실제로 적용할 시간을 살짝 줌
            await new Promise((resolve) => setTimeout(resolve, 60));
        }
        return await generateRaw(prompt);
    } finally {
        if (needsSwitch && $select.val() !== originalValue) {
            $select.val(originalValue).trigger("change");
        }
    }
}

function lorebookBlock(lorebookText) {
    if (!lorebookText) return "";
    return `\n\n--- Lorebook Entries (kink-related) ---\n${lorebookText}\n--- End Lorebook Entries ---`;
}

function buildFullPrompt(sheet, chatText, lorebookText) {
    const charName = sheet.name || "this character";
    const chatSection = chatText
        ? `\n\n## From Recent Chat (Observed)\nKink: [a natural sentence stating a kink/preference ${charName} demonstrates in the recent chat log]\nReason: [a natural sentence pointing to what happened in the chat log that shows this]\n\nKink: ...\nReason: ...\n`
        : "";
    const lorebookSection = lorebookText
        ? `\n\n## From Lorebook (Observed)\nKink: [a natural sentence stating a kink/preference ${charName} has, based on the lorebook entries]\nReason: [a natural sentence pointing to which lorebook entry supports this]\n\nKink: ...\nReason: ...\n`
        : "";
    const extraSourceNotes = [
        chatText ? `a recent chat log (identify kinks actually demonstrated in that dialogue)` : null,
        lorebookText ? `kink-related lorebook entries bound to this character` : null,
    ].filter(Boolean);
    const chatNote = extraSourceNotes.length
        ? ` You are also given ${extraSourceNotes.join(" and ")} below — treat each as its own separate source, distinct from what's merely stated in the character sheet.`
        : "";

    return `${commonInstructions(charName)}${chatNote}

Respond ONLY in English, in the exact plain-text format below. Each entry is a pair of "Kink" and "Reason" lines, written as complete, natural sentences.

## From Character Sheet (Explicit)
Kink: [a natural sentence stating the kink/preference ${charName} has]
Reason: [a natural sentence explaining which part of the sheet supports this]

Kink: ...
Reason: ...
${lorebookSection}${chatSection}
## AI-Inferred (Expanded)
Kink: [a natural sentence stating a kink/preference ${charName} has]
Reason: [a natural sentence explaining why it fits the character's established traits]

Write 3 to 6 entries per section. Do not use hyphens or bullet symbols, only the "Kink:" and "Reason:" labels. Output plain text only, no JSON, no code blocks.

${sheetBlock(sheet)}${lorebookBlock(lorebookText)}${chatBlock(chatText)}`;
}

function buildMorePrompt(sheet, existingItems, chatText, lorebookText) {
    const existingText = serializeItems(existingItems);
    return `${buildFullPrompt(sheet, chatText, lorebookText)}

You already produced the following entries earlier. This time, produce new entries that do not overlap with them:

${existingText}`;
}

function buildSingleRerollPrompt(sheet, section, existingItems, chatText, lorebookText) {
    const charName = sheet.name || "this character";
    const existingText = serializeItems(existingItems);
    const sectionLabel = SECTION_TITLES[section];
    let relevantExtraBlock = "";
    if (section === SECTION_CHAT) relevantExtraBlock = chatBlock(chatText);
    if (section === SECTION_LOREBOOK) relevantExtraBlock = lorebookBlock(lorebookText);
    return `${commonInstructions(charName)}

Produce exactly ONE new entry for the category "${sectionLabel}" that is different from all entries listed below. Respond ONLY in English with exactly these two lines and nothing else:

Kink: [a natural sentence stating the kink/preference ${charName} has]
Reason: [a natural sentence explaining the basis for it]

Existing entries to avoid duplicating:
${existingText}

${sheetBlock(sheet)}${relevantExtraBlock}`;
}

// 특정 카테고리 하나만 콕 집어서 추가 항목 생성 (다른 카테고리는 건드리지 않음)
function buildSectionOnlyPrompt(sheet, section, existingItems, chatText, lorebookText) {
    const charName = sheet.name || "this character";
    const existingText = serializeItems(existingItems);

    let instructionBody = "";
    let extraBlock = "";

    if (section === SECTION_EXPLICIT) {
        instructionBody = `Identify kink/preference entries that are explicitly stated or clearly implied by the character sheet text itself.`;
    } else if (section === SECTION_INFERRED) {
        instructionBody = `Infer plausible kink/preference entries that are not directly stated in the sheet, but fit naturally with the character's established personality, scenario, and traits.`;
    } else if (section === SECTION_CHAT) {
        instructionBody = `You are given a recent chat log below — identify kinks ${charName} actually demonstrates in that dialogue, separate from what's merely stated in the character sheet.`;
        extraBlock = chatBlock(chatText);
    } else if (section === SECTION_LOREBOOK) {
        instructionBody = `You are given kink-related lorebook entries below — identify kinks/preferences ${charName} has based on those entries, separate from what's merely stated in the character sheet's own description/personality/scenario fields.`;
        extraBlock = lorebookBlock(lorebookText);
    }

    return `${commonInstructions(charName)} ${instructionBody}

Respond ONLY in English, in the exact plain-text format below.

## ${SECTION_TITLES[section]}
Kink: [a natural sentence stating the kink/preference ${charName} has]
Reason: [a natural sentence explaining the basis for it]

Kink: ...
Reason: ...

Write 3 to 6 entries. Do not use hyphens or bullet symbols, only the "Kink:" and "Reason:" labels. Output plain text only, no JSON, no code blocks. Do not repeat any of these existing entries:
${existingText}

${sheetBlock(sheet)}${extraBlock}`;
}

function escapeHtml(text) {
    return $("<div>").text(text).html();
}

function itemMatchesSearch(item, term) {
    if (!term) return true;
    const badge = SECTION_BADGES[item.section] || "";
    const haystack = `${item.kink} ${item.reason} ${badge}`.toLowerCase();
    return haystack.includes(term.toLowerCase());
}

const SECTION_BADGES = {
    [SECTION_EXPLICIT]: "📄 Sheet",
    [SECTION_CHAT]: "💬 Chat",
    [SECTION_LOREBOOK]: "📚 Lore",
    [SECTION_INFERRED]: "🤖 AI",
};

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
                <span class="kink-source-badge kink-source-${sectionKey}">${escapeHtml(SECTION_BADGES[sectionKey])}</span>
                <p class="prose-line"><span class="field-label">Kink:</span> ${escapeHtml(it.kink)}</p>
                <p class="prose-line"><span class="field-label">Reason:</span> ${escapeHtml(it.reason)}</p>
                <div class="kink-item-actions">
                    <button class="kink-reroll-btn" data-idx="${it.idx}" title="Reroll this entry">🔁 Reroll</button>
                    <button class="kink-copy-btn" data-idx="${it.idx}" title="Copy just the Kink line">📋 Copy Kink</button>
                    <button class="kink-inject-btn" data-idx="${it.idx}" title="Add to CardInject's Kink category">➕ To CardInject</button>
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

    $out.find(".kink-inject-btn").on("click", function () {
        const idx = Number($(this).data("idx"));
        injectKinkToCardInject(idx, $(this));
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
    const lorebookResult = await getLorebookKinkText(selectedCharIndex);
    const lorebookText = lorebookResult.text;

    const $btn = mode === "more" ? $("#kink-extractor-more") : $("#kink-extractor-analyze");
    const originalText = $btn.text();
    $btn.prop("disabled", true).text("Working...");

    try {
        const prompt = mode === "more" && entry.items.length
            ? buildMorePrompt(sheet, entry.items, chatText, lorebookText)
            : buildFullPrompt(sheet, chatText, lorebookText);

        const result = await generateWithSelectedProfile(prompt);
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

async function runSectionOnlyAnalysis(section, $btn) {
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

    const settings = ensureSettings();
    const chatText = getRecentChatText(selectedCharIndex, settings.chatMessageCount);

    if (section === SECTION_CHAT && !chatText) {
        toastr?.warning?.("No chat log available - set a message count and make sure this character's chat is currently open.") ?? alert("No chat log available.");
        return;
    }

    let lorebookText = null;
    if (section === SECTION_LOREBOOK) {
        const lorebookResult = await getLorebookKinkText(selectedCharIndex);
        lorebookText = lorebookResult.text;
        if (!lorebookText) {
            const msg = lorebookResult.status === "no-book"
                ? "This character has no bound lorebook (character or chat)."
                : "No kink-related entries found in this character's lorebook(s).";
            toastr?.warning?.(msg) ?? alert(msg);
            return;
        }
    }

    const sheet = getSheetByIndex(selectedCharIndex);
    if (!sheet) return;

    const originalText = $btn.text();
    $btn.prop("disabled", true).text("Working...");

    try {
        const prompt = buildSectionOnlyPrompt(sheet, section, entry.items, chatText, lorebookText);
        const result = await generateWithSelectedProfile(prompt);
        const newItems = parseItemsFromText(result).map((it) => ({ ...it, section }));

        entry.items = [...entry.items, ...newItems];
        saveSettingsDebounced?.();
        renderResult(entry.items);
    } catch (e) {
        console.error(`[${EXT_ID}] ${section} 기반 분석 실패`, e);
        toastr?.error?.("An error occurred. Check the console.") ?? alert("An error occurred.");
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
    const originalSectionForFetch = entry.items[idx].section;
    const lorebookText = originalSectionForFetch === SECTION_LOREBOOK
        ? (await getLorebookKinkText(selectedCharIndex)).text
        : null;

    const $item = $(`.kink-item[data-idx="${idx}"]`);
    const $btn = $item.find(".kink-reroll-btn");
    $btn.prop("disabled", true).text("Rerolling...");

    try {
        const originalSection = entry.items[idx].section;
        const prompt = buildSingleRerollPrompt(sheet, originalSection, entry.items, chatText, lorebookText);
        const result = await generateWithSelectedProfile(prompt);
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

function injectKinkToCardInject(idx, $btn) {
    if (selectedCharIndex === null) return;
    const entry = getEntryByIndex(selectedCharIndex);
    if (!entry || !entry.items[idx]) return;

    const originalText = $btn.text();
    const result = addKinkToCardInject(selectedCharIndex, entry.items[idx].kink);

    if (result === "added") {
        $btn.text("Added!");
    } else if (result === "duplicate") {
        $btn.text("Already there");
    } else {
        $btn.text("Failed");
        toastr?.error?.("Couldn't reach CardInject's settings.") ?? alert("Couldn't reach CardInject's settings.");
    }
    setTimeout(() => $btn.text(originalText), 1400);
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
    const $chatBtn = $("#kink-extractor-more-chat");
    const chatAvailable = settings.chatMessageCount > 0
        && selectedCharIndex !== null
        && isSelectedCharacterActiveChat(selectedCharIndex);

    $chatBtn.prop("disabled", !chatAvailable);

    if (!settings.chatMessageCount || settings.chatMessageCount <= 0) {
        $note.text("");
        return;
    }
    if (chatAvailable) {
        $note.text(`Will include the last ${settings.chatMessageCount} messages from the currently open chat.`);
    } else {
        $note.text("This character's chat isn't currently open, so chat messages can't be included right now.");
    }
}

async function updateLorebookNote() {
    const $note = $("#kink-extractor-lorebook-note");
    const $lorebookBtn = $("#kink-extractor-more-lorebook");

    if (selectedCharIndex === null) {
        $note.text("");
        $lorebookBtn.prop("disabled", true);
        return;
    }

    const charBookName = getCharacterLorebookName(selectedCharIndex);
    const chatBookName = getChatLorebookName(selectedCharIndex);
    if (!charBookName && !chatBookName) {
        $note.text("This character has no bound lorebook (character or chat).");
        $lorebookBtn.prop("disabled", true);
        return;
    }

    const sourceLabel = [
        charBookName ? `character lore "${charBookName}"` : null,
        chatBookName ? `chat lore "${chatBookName}"` : null,
    ].filter(Boolean).join(" + ");

    $note.text(`Checking ${sourceLabel}...`);
    const result = await getLorebookKinkText(selectedCharIndex);

    if (result.status === "ok") {
        $note.text(`Found ${result.count} kink-related entries in ${sourceLabel}.`);
        $lorebookBtn.prop("disabled", false);
    } else if (result.status === "no-match") {
        $note.text(`No kink-related entries in ${sourceLabel}.`);
        $lorebookBtn.prop("disabled", true);
    } else if (result.status === "load-failed") {
        $note.text(`Couldn't load ${sourceLabel}.`);
        $lorebookBtn.prop("disabled", true);
    } else {
        $note.text("");
        $lorebookBtn.prop("disabled", true);
    }
}

function refreshPopupForSelectedCharacter() {
    searchTerm = "";
    $("#kink-extractor-search").val("");

    const settings = ensureSettings();
    $("#kink-extractor-chat-count").val(settings.chatMessageCount);
    updateChatNote();
    updateLorebookNote();

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

                <div id="kink-extractor-lorebook-note" class="kink-extractor-chat-note"></div>

                <div class="kink-extractor-buttons">
                    <button id="kink-extractor-analyze" class="menu_button primary">Analyze</button>
                </div>

                <div class="kink-extractor-more-header">
                    <span class="kink-extractor-more-label">Add more suggestions</span>
                    <span id="kink-extractor-reset" class="kink-extractor-reset-link">🗑 Reset all</span>
                </div>
                <div class="kink-extractor-more-list">
                    <button id="kink-extractor-more-explicit" class="kink-more-btn" data-section="explicit"><span class="kink-more-icon">📄</span> Sheet suggestions</button>
                    <button id="kink-extractor-more-inferred" class="kink-more-btn" data-section="inferred"><span class="kink-more-icon">🤖</span> AI suggestions</button>
                    <button id="kink-extractor-more-chat" class="kink-more-btn" data-section="chat"><span class="kink-more-icon">💬</span> Chat suggestions</button>
                    <button id="kink-extractor-more-lorebook" class="kink-more-btn" data-section="lorebook"><span class="kink-more-icon">📚</span> Lorebook suggestions</button>
                    <button id="kink-extractor-more-all" class="kink-more-btn kink-more-btn-all"><span class="kink-more-icon">🔀</span> All suggestions</button>
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

    $("#kink-extractor-more-explicit").on("click", function () {
        runSectionOnlyAnalysis(SECTION_EXPLICIT, $(this));
    });
    $("#kink-extractor-more-inferred").on("click", function () {
        runSectionOnlyAnalysis(SECTION_INFERRED, $(this));
    });
    $("#kink-extractor-more-chat").on("click", function () {
        runSectionOnlyAnalysis(SECTION_CHAT, $(this));
    });
    $("#kink-extractor-more-lorebook").on("click", function () {
        runSectionOnlyAnalysis(SECTION_LOREBOOK, $(this));
    });
    $("#kink-extractor-more-all").on("click", () => runFullAnalysis("more"));

    $("#kink-extractor-reset").on("click", function () {
        if (selectedCharIndex === null) return;
        const entry = getEntryByIndex(selectedCharIndex);
        if (!entry || !entry.items.length) return;
        if (!confirm("Clear all results for this character? This can't be undone.")) return;
        entry.items = [];
        saveSettingsDebounced?.();
        renderResult(entry.items);
    });
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

// 확장탭(#extensions_settings2)에 "분석용 프로필" 선택 패널을 별도로 추가
// 여기서 골라도 ST의 실제 연결은 그대로 유지되고, Analyze/추가 제안/리롤을 실행하는 그 순간에만 잠깐 전환됐다가 끝나면 자동으로 원래 프로필로 복귀함
function populateProfileSelect() {
    const $select = $("#kink-extractor-profile-select");
    if (!$select.length) return;

    const settings = ensureSettings();
    const $sourceSelect = findProfileSelectEl();

    $select.empty();
    $select.append(`<option value="">(Don't switch - use whatever's active)</option>`);

    if ($sourceSelect && $sourceSelect.length) {
        $sourceSelect.find("option").each(function () {
            const val = $(this).val();
            const label = $(this).text().trim();
            if (!val) return;
            $select.append(`<option value="${escapeHtml(val)}">${escapeHtml(label)}</option>`);
        });
    } else {
        $select.append(`<option value="" disabled>(Couldn't find ST's profile list)</option>`);
    }

    $select.val(settings.analysisProfileId || "");
}

function buildExtensionsTabPanel() {
    if ($("#kink-extractor-settings-panel").length) return;

    const html = `
    <div id="kink-extractor-settings-panel" class="kink-extractor-settings-panel">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Kink Extractor</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="kink-extractor-label" for="kink-extractor-profile-select">Analysis Profile (only switches while analyzing)</label>
                <select id="kink-extractor-profile-select" class="kink-extractor-char-select"></select>
            </div>
        </div>
    </div>`;

    $("#extensions_settings2").append(html);
    populateProfileSelect();

    $("#kink-extractor-profile-select").on("change", function () {
        const settings = ensureSettings();
        settings.analysisProfileId = $(this).val() || null;
        saveSettingsDebounced?.();
    });
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
    buildExtensionsTabPanel();
});
