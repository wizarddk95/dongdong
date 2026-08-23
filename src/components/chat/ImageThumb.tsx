/**
 * 첨부 이미지 하나의 썸네일.
 *
 * 입력칸 위(보내기 전)와 말풍선 안(보낸 뒤)이 **같은 부품**을 쓴다 — 두 자리가 이미지를
 * 다르게 그리면 "보낸 것과 보이는 것이 같은가" 를 사람이 확인할 방법이 없다.
 *
 * 바이트는 `.agent_workspace` 에 있으므로 `<img src>` 에 경로를 줄 수 없다(CSP 가 `self` 다).
 * `data:` URL 로 그린다 — `img-src ... data:` 는 이미 열려 있다.
 */
import { useEffect, useState } from "react";

import type { ImageAttachment } from "@/lib/ai/attachments";
import { formatBytes } from "@/lib/ai/attachments";
import { useT } from "@/lib/i18n/useT";
import { loadAttachment, toDataUrl } from "@/lib/images";

interface Props {
  image: ImageAttachment;
  projectPath?: string;
  /** 있으면 [×] 가 붙는다 (보내기 전에만) */
  onRemove?: () => void;
  /** 한 변의 픽셀. 목록용은 작게, 말풍선은 조금 크게 */
  size?: number;
}

export function ImageThumb({ image, projectPath, onRemove, size = 56 }: Props) {
  const t = useT();
  const [src, setSrc] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let alive = true;
    setSrc(null);
    setMissing(false);

    void loadAttachment(image.sha, projectPath).then((bytes) => {
      if (!alive) return;
      if (bytes) setSrc(toDataUrl(bytes));
      else setMissing(true);
    });

    return () => {
      alive = false;
    };
  }, [image.sha, projectPath]);

  const title = `${image.name} · ${image.width}×${image.height} · ${formatBytes(image.size)}`;

  return (
    <span
      className="group/thumb relative inline-flex shrink-0 overflow-hidden rounded-md border border-hairline bg-surface-1"
      style={{ width: size, height: size }}
      title={title}
    >
      {src ? (
        <img src={src} alt={image.name} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center px-1 text-center text-caption text-ink-subtle">
          {missing ? t("attachment.none") : "…"}
        </span>
      )}

      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title={t("image.remove")}
          aria-label={t("image.remove")}
          // 늘 떠 있으면 작은 썸네일을 반쯤 가린다 — 올렸을 때만 보인다.
          // (투명도 수식 대신 불투명 토큰을 쓴다 — `bg-canvas/85` 는 다크에서 라이트 값이 박힌다)
          className="absolute right-0.5 top-0.5 rounded-sm border border-hairline bg-canvas px-1 text-caption leading-none text-ink-muted opacity-0 transition-opacity hover:text-ink group-hover/thumb:opacity-100 focus-visible:opacity-100"
        >
          ×
        </button>
      )}
    </span>
  );
}
