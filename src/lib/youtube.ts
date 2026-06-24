const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

function cleanYouTubeId(value: string | null | undefined) {
  const candidate = value?.trim() ?? "";
  return YOUTUBE_ID_PATTERN.test(candidate) ? candidate : "";
}

function isYouTubeHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return (
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com")
  );
}

export function getYouTubeId(input: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const url = new URL(trimmed);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");

    if (hostname === "youtu.be") {
      return cleanYouTubeId(url.pathname.split("/").filter(Boolean)[0]);
    }

    if (isYouTubeHost(hostname)) {
      const fromSearch = url.searchParams.get("v");
      if (fromSearch) {
        return cleanYouTubeId(fromSearch);
      }

      const shortsMatch = url.pathname.match(/\/shorts\/([^/?]+)/);
      if (shortsMatch?.[1]) {
        return cleanYouTubeId(shortsMatch[1]);
      }

      const embedMatch = url.pathname.match(/\/embed\/([^/?]+)/);
      if (embedMatch?.[1]) {
        return cleanYouTubeId(embedMatch[1]);
      }
    }
  } catch {
    return cleanYouTubeId(trimmed);
  }

  return "";
}

export function getYouTubeEmbedUrl(input: string) {
  const id = getYouTubeId(input);
  return id ? `https://www.youtube.com/embed/${id}?start=0&controls=1&modestbranding=1` : "";
}

export function getYouTubeThumbnailUrl(input: string) {
  const id = getYouTubeId(input);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : "";
}
