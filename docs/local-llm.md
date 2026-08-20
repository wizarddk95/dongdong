# 로컬 오픈소스 LLM 붙이기 (RTX 5080 · 16GB)

dongdong 은 `local` 공급자로 **이 PC 에서 도는 OpenAI 호환 서버**를 그대로 호출한다.
Ollama · LM Studio · llama.cpp server · vLLM 이 모두 같은 `/v1/chat/completions` 를 내주므로
주소만 맞추면 된다. 키가 없고, 대화 내용이 이 PC 밖으로 나가지 않는다.

---

## 0. 용어부터 — 오픈소스 모델이 처음이라면

### 모델은 "프로그램"이 아니라 "파일"이다

`gpt-oss:20b` 같은 모델은 실행 파일이 아니라 **숫자 덩어리가 든 14GB짜리 파일 하나**다.
그 안에는 "이 단어들 다음에는 이 단어가 올 확률이 높다"는 계산에 쓰이는 가중치만 들어 있다.
파일을 더블클릭한다고 뭐가 되지 않는다. 이 파일을 GPU 메모리에 올리고, 글을 넣으면
다음 글자를 계산해서 뱉어 주는 **별도의 프로그램**이 필요하다. 그게 추론 엔진이다.

### Ollama = 다운로드 관리자 + 추론 엔진 + HTTP 서버

Ollama 는 그 세 가지를 하나로 묶은 프로그램이다. `npm` 이나 `docker` 를 떠올리면 가깝다.

| 하는 일 | 명령 | 비유 |
| --- | --- | --- |
| 모델 파일을 받아 관리 | `ollama pull gpt-oss:20b` | `npm install` |
| 모델을 GPU 에 올려 계산 | (자동) | 런타임 |
| 다른 프로그램이 쓸 수 있게 대기 | (백그라운드 상주) | 로컬 웹 서버 |

`gpt-oss:20b` 에서 `:20b` 는 도커 이미지 태그와 같은 자리다 — 같은 모델의 크기·양자화 변종을 고른다.

### "로컬 모델 서버"의 서버는 무슨 뜻인가

앱이 모델과 대화하는 방법은 예나 지금이나 **HTTP 요청**이다.
클라우드를 쓸 때 dongdong 은 `https://api.anthropic.com` 으로 "이 대화 이어서 써 줘" 라는
JSON 을 보내고 답을 받는다. Ollama 를 설치하면 **똑같은 모양의 요청을 받아 주는 창구가
내 PC 안에 하나 열린다.** 보내는 주소만 바뀌는 것이다.

```
[클라우드]  dongdong ──HTTP──▶ https://api.anthropic.com  (인터넷 건너편, 키 필요, 과금)
[로컬]      dongdong ──HTTP──▶ http://localhost:11434/v1  (내 PC 안, 키 없음, 공짜)
                                        │
                                        └─ Ollama ─▶ RTX 5080 (모델이 올라가 있는 곳)
```

주소를 뜯어보면:

- `http://` — 인터넷을 안 타므로 `https` 가 아니어도 된다
- `localhost` — "이 컴퓨터 자신". 밖에서는 접근할 수 없는 주소다
- `11434` — 포트. 한 컴퓨터 안에서 프로그램들을 구분하는 번호(Ollama 는 11434, LM Studio 는 1234)
- `/v1` — API 경로. OpenAI 가 쓰던 규격을 다들 그대로 흉내 내서 사실상 표준이 됐다

이 "흉내"가 핵심이다. 덕분에 dongdong 은 로컬 모델을 붙이려고 코드를 새로 짤 필요가 없었고,
공급자 하나(`local`)와 주소 입력칸만 추가하면 끝났다. 같은 이유로 Ollama 대신
LM Studio·llama.cpp·vLLM 을 써도 그대로 동작한다.

### 그래서 설치 명령이 뭘 하는지

```powershell
winget install Ollama.Ollama
```

`winget` 은 Windows 11 에 기본으로 들어 있는 **패키지 관리자**다. 홈페이지에서 설치 파일을
직접 받아 실행하는 것과 결과가 같고, 명령 한 줄로 끝난다는 점만 다르다.
설치가 끝나면 Ollama 가 트레이(시계 옆)에 상주하면서 11434 포트를 열어 둔다.

```powershell
setx OLLAMA_CONTEXT_LENGTH 65536
```

`setx` 는 **환경 변수를 영구적으로 저장**하는 명령이다(`set` 은 그 창에서만, `setx` 는 계속).
환경 변수는 "프로그램이 시작할 때 읽어 가는 설정 쪽지" 라고 보면 된다.
Ollama 는 설정 화면이 따로 없어서 옵션을 이 방식으로 받는다.

무엇을 설정하는가 — **컨텍스트 길이**, 즉 모델이 한 번에 읽을 수 있는 분량의 상한이다.
단위인 토큰은 대략 단어 조각이고, 한글은 글자당 1~2 토큰쯤 된다.
Ollama 의 기본값은 VRAM 24GB 미만에서 **4096 토큰(대략 A4 두세 장)** 인데,
에이전트는 도구 설명서와 프로젝트 지침만으로 그 분량을 넘긴다.
넘긴 부분은 조용히 잘려 나가고, 모델은 자기가 받아야 할 지시를 못 본 채 엉뚱한 답을 하거나
빈 응답을 준다. **로컬 모델이 갑자기 바보가 되는 사고의 대부분이 이것**이다.
그래서 65536(64K)으로 미리 올려 둔다.

주의할 점 두 가지:

- 환경 변수는 **새로 시작하는 프로그램부터** 적용된다. 이미 떠 있는 Ollama 를 트레이에서
  완전히 종료했다가 다시 켜야 한다.
- 컨텍스트를 늘리면 그만큼 VRAM 을 더 먹는다(64K ≈ +2GB). 모델 로딩이 실패하면
  32768 → 16384 로 내린다.

---

## 1. 하드웨어 제약부터 — 16GB 안에 뭐가 들어가나

RTX 5080 은 **16GB GDDR7**(Blackwell). 로컬 LLM 에서 실제로 쓸 수 있는 건 대략 **14.5GB** 정도다
(윈도우 데스크톱·브라우저가 1~1.5GB 를 먼저 먹는다).

VRAM 을 쓰는 건 세 덩어리다.

| 항목 | 크기 |
| --- | --- |
| 가중치 | 파라미터 수 × 비트/8. Q4_K_M ≈ 파라미터 수 × 0.6GB/B |
| KV 캐시 | 컨텍스트에 비례. 16K ≈ +0.5GB, 64K ≈ +2GB |
| 실행 버퍼 | 0.5~1GB |

**에이전트는 컨텍스트를 크게 먹는다.** 도구 스키마 + AGENTS.md + 도구 출력이 매 스텝 다시 올라가서
한 턴에 수만 토큰이 흔하다. 그래서 "가중치가 15.9GB 라 아슬아슬하게 들어간다"는 계산은 실패한다 —
**가중치는 12~14GB 로 잡고 나머지를 KV 캐시에 남겨야** 한다.

---

## 2. 모델 추천 (에이전트 = 도구 호출 품질이 1순위)

| 모델 | 태그 | 크기 | 컨텍스트 | 판단 |
| --- | --- | --- | --- | --- |
| **gpt-oss 20B** | `gpt-oss:20b` | 14GB (MXFP4) | 128K | **첫 후보.** MoE 라 20B 치고 빠르고, 함수 호출·구조화 출력이 학습 단계부터 들어가 있다. 애초에 16GB 머신을 겨냥해 양자화된 모델 |
| **Qwen3-Coder 30B-A3B** | `qwen3-coder:30b` | 19GB (Q4_K_M) | 256K | 코딩·에이전트 품질은 이 목록 최강. 다만 19GB > 16GB 라 일부 레이어를 CPU 로 내려야 한다(MoE 라 활성 3.3B — 오프로드해도 체감 속도가 덜 죽는다) |
| **Devstral 24B** | `devstral:24b` | ~14GB (Q4_K_M) | 128K | 에이전트 루프용으로 학습된 밀집 모델. GPU 에 온전히 올라간다 |
| **Qwen3 14B** | `qwen3:14b` | ~9GB (Q4_K_M) | 128K | VRAM 여유가 가장 크다 = 컨텍스트를 가장 길게 잡을 수 있다. 품질보다 응답 속도가 중요할 때 |

정리하면:

- **그냥 잘 되는 걸 원한다 → `gpt-oss:20b`**
- **코드 품질을 최대로, 조금 느려도 된다 → `qwen3-coder:30b`**
- **서브에이전트처럼 여러 개를 굴린다 → `qwen3:14b`**

> 30B / 70B 급을 온전히 GPU 에 올리려면 24GB(4090·5090) 이상이 필요하다. 5080 에서 70B 는 현실적이지 않다.

### 양자화를 얼마나 내릴 것인가

에이전트 용도에서는 **Q4 아래로 내리지 말 것**. 양자화를 낮추면 산문 품질보다
**도구 호출 JSON 의 형식 안정성이 먼저 무너진다** — 인자 이름이 틀리거나 따옴표가 깨지고,
그러면 루프가 통째로 헛돈다. VRAM 이 남으면 Q4 → Q5/Q6 로 올리는 편이 컨텍스트를 늘리는 것보다 나을 때가 많다.

---

## 3. 설치 (Windows)

### Ollama

```powershell
winget install Ollama.Ollama
# 또는 https://ollama.com/download

ollama pull gpt-oss:20b          # 14GB, 몇 분 걸린다
ollama list                      # 받은 태그 확인
ollama run gpt-oss:20b "안녕"    # 동작 확인
```

**컨텍스트를 반드시 늘린다.** Ollama 는 VRAM 24GB 미만이면 기본 컨텍스트가 **4K** 다.
에이전트 한 턴이 그 자리에서 넘어가 응답이 잘리거나 빈 문자열이 온다.
게다가 `/v1` 경로는 요청 본문의 `num_ctx` 를 무시하므로 **서버 쪽에서 잡아야** 한다.

```powershell
setx OLLAMA_CONTEXT_LENGTH 65536
# 트레이의 Ollama 를 완전히 종료 후 재시작 (환경 변수는 새 프로세스부터 먹는다)
```

VRAM 이 모자라 뻗으면 32768 → 16384 로 내린다.

### LM Studio (GUI 를 선호한다면)

1. https://lmstudio.ai 설치 → Discover 탭에서 모델 검색·다운로드
2. **Developer → Start Server** (기본 `http://localhost:1234/v1`)
3. 모델 로드 화면에서 `Context Length` 와 `GPU Offload` 슬라이더를 직접 조절 —
   16GB 를 넘는 모델을 부분 오프로드할 때는 이쪽이 다루기 쉽다

### `qwen3-coder:30b` 처럼 VRAM 을 넘길 때

19GB 모델을 16GB 카드에 올리면 Ollama 가 알아서 일부 레이어를 CPU 로 내린다(느려지지만 돈다).
MoE 는 **전문가 레이어만 CPU 로 내리는** 편이 훨씬 빠르다 — llama.cpp 계열의 `--n-cpu-moe`,
LM Studio 의 "Force MoE expert weights onto CPU" 옵션이 그것이다.

---

## 4. dongdong 에 연결

1. 우측 상단 **[설정] → "로컬 모델 서버"**
2. 서버 주소 확인 (Ollama `http://localhost:11434/v1`, LM Studio `http://localhost:1234/v1`)
3. **[설치된 모델 불러오기]** — 서버의 `GET /v1/models` 를 읽어 실제 깔린 태그를 드롭다운에 채운다
4. **모델** 드롭다운에서 `... (로컬)` 항목 선택 → 저장

직접 입력할 때의 형식은 `local:<태그>` 다 (예: `local:gpt-oss:20b`).
상단 모델 셀렉터에서도 바로 전환된다.

로컬 모델로 돌릴 때 권장 설정:

- **최대 스텝**: 8 이하 (로컬은 스텝당 지연이 크다)
- **스킬**: 필요한 것만. 도구 스키마가 곧 컨텍스트이고, 작은 모델은 도구가 많을수록 오답이 는다
- **사고 강도**: Anthropic 전용이라 로컬에서는 무시된다

---

## 5. 알아 둘 것

- **첫 요청이 느리다.** 모델을 VRAM 에 올리는 시간(14GB 면 10~30초)이 그대로 첫 토큰 지연이 된다.
  Ollama 는 5분간 놀면 언로드하므로 그 뒤 첫 질문은 다시 느리다.
- **중단은 그대로 동작한다.** `lib/ai/abort.ts` 가 도구를 중단 시그널과 경주시키는 구조라 공급자와 무관하다.
- **컨텍스트 인스펙터가 그대로 쓸모 있다.** 로컬 모델이 이상하게 굴 때 실제로 무엇이 올라갔는지
  (도구 스키마가 컨텍스트를 다 먹지 않았는지) 노드에서 바로 확인할 수 있다.
- **`/v1/models` 는 뜨는데 호출이 400 이면** 대개 Responses API 로 보낸 경우다.
  dongdong 은 `createOpenAI(...).chat()` 으로 `/v1/chat/completions` 를 쓴다(`lib/ai/providers.ts`).
- **품질 기대치**: 16GB 로컬 모델은 Claude/GPT 급 한 방 정확도를 내지 못한다.
  파일 읽기·검색·간단한 수정·요약 같은 좁은 작업, 그리고 서브에이전트 위임 대상으로 쓰는 게 현실적이다.

---

## 출처

- [Ollama — Context length](https://docs.ollama.com/context-length)
- [Ollama — gpt-oss](https://ollama.com/library/gpt-oss) · [qwen3-coder:30b](https://ollama.com/library/qwen3-coder:30b)
- [Ollama — OpenAI compatibility](https://ollama.com/blog/openai-compatibility)
- [ModelFit — RTX 5080 16GB 모델별 VRAM·속도 추정](https://modelfit.io/gpu/rtx-5080/)
- [Morph — Best Ollama Models 2026 (VRAM·SWE-Bench 정리)](https://www.morphllm.com/best-ollama-models)
- [Best Local LLM for RTX 5080 (2026)](https://openclawdc.com/blog/best-local-llm-rtx-5080/)
- [unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF](https://huggingface.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF)
