import { type MarkdownWorkerState } from "./markdown-worker-protocol";
export declare function highlightStreamingCode(key: string, text: string, language: string, complete?: boolean): Promise<MarkdownWorkerState>;
export declare function disposeStreamingCode(key: string): void;
export declare class MarkdownWorkerDisposedError extends Error {
}
export declare class MarkdownWorkerSupersededError extends Error {
}
export declare class MarkdownWorkerUnavailableError extends Error {
}
