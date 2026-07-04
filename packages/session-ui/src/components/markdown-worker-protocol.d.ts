import type { ThemeRegistrationResolved } from "shiki";
export type MarkdownToken = [content: string, style: string];
export type MarkdownWorkerRequest = {
    type: "init";
    theme: ThemeRegistrationResolved;
} | {
    type: "highlight";
    id: number;
    key: string;
    text: string;
    language: string;
    complete?: boolean;
} | {
    type: "dispose";
    key: string;
};
export type MarkdownWorkerResponse = {
    type: "highlight";
    id: number;
    key: string;
    reset: boolean;
    stable: MarkdownToken[];
    unstable: MarkdownToken[];
} | {
    type: "error";
    id: number;
    key: string;
    message: string;
} | {
    type: "superseded";
    id: number;
    key: string;
};
export type MarkdownWorkerState = {
    id: number;
    generation: number;
    stable: MarkdownToken[];
    unstable: MarkdownToken[];
};
export declare function shouldReleaseMarkdownWorkerState(complete: boolean, latestID: number | undefined, responseID: number): boolean;
export declare function markdownBlockKey(owner: string, cacheKey: string | undefined, index: number, mode: string): string;
export declare function applyMarkdownWorkerResponse(state: MarkdownWorkerState | undefined, response: Extract<MarkdownWorkerResponse, {
    type: "highlight";
}>): MarkdownWorkerState;
