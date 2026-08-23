/**
 * 이미지 한 장이 몇 토큰인지 — **공급자마다 공식이 다르다**.
 *
 * 왜 따로 세는가: 컨텍스트 게이지(`usage.ts` 의 `projectTokens()`)는 "자 수 ÷ 실측 토큰"
 * 비율로 굴러간다. 그런데 이미지는 페이로드에 **참조 한 토막**(`dd-image:<sha>`)으로만
 * 실리므로 자 수가 거의 0인데 토큰은 수천이다. 그대로 두면 비율이 통째로 망가져서
 * 이미지를 한 장 붙인 뒤 남은 대화 전체를 과소평가한다.
 * → 이미지 몫은 자 수 환산에서 **빼고**, 여기서 따로 세어 더한다.
 *
 * 전부 근사다(공급자가 공식을 못 박아 두지 않았거나 세대마다 바뀐다). 그래서 화면에는
 * 언제나 근사 표시와 함께 나간다 — 정확한 수는 턴이 끝난 뒤 공급자가 세어 준 값이다.
 */
import { parseModelId } from "@/lib/ai/providers";

/** 토큰을 셀 수 있을 만큼의 정보. 픽셀을 모르면 셀 수 없다. */
export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * 공급자에게 보내기 전에 웹뷰가 줄이는 긴 변 상한.
 *
 * Anthropic 은 1568px 를 넘으면 **서버에서 알아서 줄이는데 요금은 원본 기준**으로 낸다
 * — 4K 스크린샷 한 장이 ~5,000 토큰이고, 줄이면 ~1,600 토큰이다. 품질 손해는 거의 없다.
 */
export const MAX_IMAGE_EDGE = 1568;

/** Anthropic: 넓이 × 높이 ÷ 750. */
function anthropicTokens({ width, height }: ImageDimensions): number {
  return Math.ceil((width * height) / 750);
}

/**
 * Google: 384px 안에 들어오면 한 장 값(258), 아니면 768×768 타일마다 258.
 * Gemini 는 OpenAI 호환 계층을 타지만 **과금은 구글 공식**이므로 여기로 온다.
 */
function googleTokens({ width, height }: ImageDimensions): number {
  const TILE_TOKENS = 258;
  if (width <= 384 && height <= 384) return TILE_TOKENS;

  const tiles = Math.ceil(width / 768) * Math.ceil(height / 768);
  return tiles * TILE_TOKENS;
}

/**
 * OpenAI: 2048 상자에 맞춘 뒤 짧은 변을 768 로 줄이고, 512 타일마다 170 + 기본 85.
 * 세대마다 배수가 다르지만(mini 계열은 더 크다) 자릿수는 이 공식이 맞는다.
 */
function openaiTokens({ width, height }: ImageDimensions): number {
  const BASE_TOKENS = 85;
  const TILE_TOKENS = 170;

  let [w, h] = [width, height];
  const longest = Math.max(w, h);
  if (longest > 2048) {
    const scale = 2048 / longest;
    [w, h] = [w * scale, h * scale];
  }
  const shortest = Math.min(w, h);
  if (shortest > 768) {
    const scale = 768 / shortest;
    [w, h] = [w * scale, h * scale];
  }

  const tiles = Math.ceil(w / 512) * Math.ceil(h / 512);
  return BASE_TOKENS + tiles * TILE_TOKENS;
}

/**
 * 이미지 한 장의 토큰 수. 픽셀을 모르면 `null` — 0 으로 접으면 게이지가 조용히 거짓말을 한다.
 *
 * 로컬 모델은 공식이 서버마다 달라서 Anthropic 공식으로 어림한다(자릿수는 맞는다).
 */
export function imageTokens(
  modelId: string,
  dimensions: ImageDimensions | null,
): number | null {
  if (!dimensions) return null;
  const { width, height } = dimensions;
  if (!(width > 0) || !(height > 0)) return null;

  switch (parseModelId(modelId).provider) {
    case "google":
      return googleTokens(dimensions);
    case "openai":
      return openaiTokens(dimensions);
    default:
      return anthropicTokens(dimensions);
  }
}

/** 여러 장의 합. 픽셀을 모르는 장은 빠진다(모르는 것을 0 으로 세지는 않는다). */
export function sumImageTokens(
  modelId: string,
  images: (ImageDimensions | null)[],
): number {
  return images.reduce<number>((total, size) => total + (imageTokens(modelId, size) ?? 0), 0);
}

/**
 * 긴 변을 `MAX_IMAGE_EDGE` 안으로 줄인 크기. 이미 작으면 그대로 돌려준다.
 * 실제로 픽셀을 만지는 일은 `lib/images.ts` 가 하고, **얼마로 줄일지는 여기서만 정한다**
 * — 축소한 크기와 토큰을 세는 크기가 어긋나면 게이지가 틀린다.
 */
export function fitWithinMaxEdge(
  { width, height }: ImageDimensions,
  maxEdge = MAX_IMAGE_EDGE,
): ImageDimensions {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };

  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
