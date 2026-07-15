# Kink Extractor

AI로 캐릭터 카드(그리고 원하면 최근 채팅 로그까지)를 분석해서, 그 캐릭터가 가질 법한 성적 취향/킨크를 정리해주는 SillyTavern 확장이야.

**성인(만 18세 이상) 캐릭터 전용이야.** 분석 전에 반드시 "이 캐릭터는 성인입니다" 체크박스를 확인해야 동작해.

---

## 뭘 해주는 확장이야?

캐릭터 시트(설명, 성격, 시나리오, 대화 예시)를 읽고, 필요하면 최근 채팅 로그도 함께 읽어서 AI에게 분석을 맡겨. 결과는 아래 세 카테고리로 나뉘어:

- 📄 **From Character Sheet (Explicit)** — 캐시트에 명시적으로 드러난 취향
- 💬 **From Recent Chat (Observed)** — 실제 채팅에서 드러난 취향 (설정에서 켰을 때만)
- 🤖 **AI-Inferred (Expanded)** — 캐시트 설정과 자연스럽게 어울리는, AI가 유추한 취향

각 항목은 `Kink: 문장` / `Reason: 근거 문장` 한 쌍으로, 줄글 서술 형태로 나와.

---

## 설치

1. SillyTavern에서 **Extensions → Install extension** 이동
2. 저장소 URL 붙여넣기
3. Install 클릭

---

## 사용법

1. 확장 완드(🪄) 메뉴에서 **Kink Extractor** 클릭 → 팝업이 화면 중앙에 뜸
2. 상단 **Character** 드롭다운에서 분석할 캐릭터 선택 (지금 채팅 중인 캐릭터가 자동으로 선택돼있음)
3. **This character is an adult (18+)** 체크
4. (선택) **Recent chat messages to include**에 숫자를 넣으면, 지금 실제로 열려있는 그 캐릭터의 채팅에서 최근 N개 메시지를 같이 분석해줘. 하이드(숨김) 처리된 메시지도 포함해서 읽음
5. **Analyze** 클릭 → 캐시트 + AI 추론 + (설정했다면) 채팅까지 한 번에 분석

---

## 추가 제안 (Add more suggestions)

한 번 분석한 뒤에도, 특정 카테고리만 콕 집어서 더 뽑아낼 수 있어. 기존 항목과 겹치지 않게 새 항목만 추가돼.

| 버튼 | 설명 |
| --- | --- |
| 📄 Sheet suggestions | 캐시트 기반 항목만 추가 |
| 🤖 AI suggestions | AI 추론 항목만 추가 |
| 💬 Chat suggestions | 채팅 기반 항목만 추가 (채팅 개수 설정 + 해당 캐릭터 채팅이 지금 열려있어야 함) |
| 🔀 All suggestions | 세 카테고리 전부에서 겹치지 않게 추가 |

---

## 항목별 기능

각 킨크 항목마다 이런 걸 할 수 있어:

- 🔁 **Reroll** — 그 항목 하나만 다시 생성 (다른 항목은 그대로)
- 📋 **Copy Kink** — Kink 문장 한 줄만 클립보드로 복사 (근거는 제외)
- ➕ **To CardInject** — [CardInject](https://github.com/foreverharibo-boop/cardinject) 확장이 설치돼 있으면, 그 캐릭터의 "Sexuality & Kink" 카테고리(이미 kink/sexuality/sexual이 이름에 들어간 카테고리가 있으면 그걸 그대로 사용)에 바로 추가해줌

결과창 위쪽 **Search** 입력창으로 킨크/근거 텍스트나 카테고리 이름(Sheet/Chat/AI)으로 필터링 가능하고, **Copy** 버튼으로 전체 결과를 한 번에 복사할 수 있어.

---

## 참고사항

- **캐릭터별 독립 저장**: 분석 결과와 성인 확인 체크 상태는 캐릭터마다 따로 저장돼. ST 서버 설정(`settings.json`)에 저장되기 때문에 팝업을 껐다 켜거나 새로고침해도 그대로 남아있어.
- **채팅 로그는 "현재 열려있는 채팅"에서만 읽을 수 있어**: 드롭다운에서 지금 안 열려있는 다른 캐릭터를 선택하면, 그 캐릭터의 채팅 로그에는 접근할 수 없어서 채팅 기반 분석이 비활성화돼.
- **CardInject 연동은 별도 설치가 필요해**: CardInject가 설치·활성화되어 있어야 "To CardInject" 버튼이 정상 작동해. CardInject 쪽에서 이미 분석해둔 카테고리가 있는 상태에서 CardInject의 "AI로 캐시트 분석하기"를 다시 누르면 카테고리 전체가 덮어써지니, 순서에 주의해줘.
- 분석 중에는 결과가 나올 때까지 버튼이 비활성화돼. 너무 오래 걸리면 연결된 AI 상태를 확인해줘.

---

## 요구사항

- SillyTavern (최신 빌드 권장)
- 활성화된 AI 연결
- (선택) [CardInject](https://github.com/foreverharibo-boop/cardinject) — 카테고리 자동 연동 기능을 쓰려면 필요
