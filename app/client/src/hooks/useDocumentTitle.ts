import { useEffect } from "react";

const BASE_TITLE = typeof document !== "undefined" ? document.title : "";

export function useDocumentTitle(title?: string | null) {
  useEffect(() => {
    document.title = title ? `${title} | ${BASE_TITLE}` : BASE_TITLE;
  }, [title]);
}
