/**
 * 图片下载辅助:把 http(s) URL 或本地文件路径统一加载为 Buffer,
 * 供 WeCom Agent API / Bot WS sendMedia 使用。
 *
 * 与 outbound.ts 的媒体下载逻辑保持一致:
 * - http/https 使用原生 fetch + 30s 超时
 * - 其它路径按本地文件处理(fs.readFile),尝试根据扩展名推断 MIME
 */

const MIME_BY_EXT: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
};

export interface ImagePayload {
    buffer: Buffer;
    filename: string;
    contentType: string;
}

/**
 * 下载图片 URL 或读取本地文件,返回上传所需的 buffer + 文件名 + MIME。
 *
 * @throws 下载/读取失败或超时
 */
export async function loadImageAsPayload(url: string): Promise<ImagePayload> {
    const src = String(url ?? "").trim();
    if (!src) {
        throw new Error("Image source URL is empty");
    }

    if (/^https?:\/\//i.test(src)) {
        const res = await fetch(src, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) {
            throw new Error(`Failed to download image (status ${res.status}): ${src}`);
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        const urlPath = (() => {
            try {
                return new URL(src).pathname;
            } catch {
                return "";
            }
        })();
        const nameFromPath = urlPath.split("/").pop() || "";
        const filename = nameFromPath || "image";
        const contentType = res.headers.get("content-type")
            || inferMimeFromFilename(filename)
            || "application/octet-stream";
        return { buffer, filename, contentType };
    }

    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const buffer = await fs.readFile(src);
    const filename = path.basename(src) || "image";
    const contentType = inferMimeFromFilename(filename) || "application/octet-stream";
    return { buffer, filename, contentType };
}

function inferMimeFromFilename(name: string): string | undefined {
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    if (!ext) return undefined;
    return MIME_BY_EXT[ext];
}
