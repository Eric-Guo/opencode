import { type ViewDiff } from "./session-diff";
type Kind = "add" | "update" | "delete" | "move";
export type ApplyPatchFile = {
    filePath: string;
    relativePath: string;
    type: Kind;
    additions: number;
    deletions: number;
    movePath?: string;
    view: ViewDiff;
};
export declare function patchFile(raw: unknown): ApplyPatchFile | undefined;
export declare function patchFiles(raw: unknown): ApplyPatchFile[];
export {};
