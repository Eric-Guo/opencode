export type MarkdownCacheEntry = {
    raw: string;
    hash: string;
    html: string;
};
export declare function sanitizeMarkdown(html: string): string;
export declare function getCachedMarkdown(key: string): MarkdownCacheEntry | undefined;
export declare function touchCachedMarkdown(key: string, value: MarkdownCacheEntry): void;
export declare function preloadMarkdown(text: string, cacheKey: string, parser: {
    parse(text: string): string | Promise<string>;
}): Promise<void>;
