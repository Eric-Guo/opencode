import { Component, type JSX } from "solid-js";
import { AssistantMessage, Message as MessageType, Part as PartType, ToolPart, UserMessage } from "@opencode-ai/sdk/v2";
export interface MessageProps {
    message: MessageType;
    parts: PartType[];
    actions?: UserActions;
    showAssistantCopyPartID?: string | null;
    showReasoningSummaries?: boolean;
    useV2Actions?: boolean;
}
export type SessionAction = (input: {
    sessionID: string;
    messageID: string;
}) => Promise<void> | void;
export type UserActions = {
    fork?: SessionAction;
    revert?: SessionAction;
};
export interface MessagePartProps {
    part: PartType;
    message: MessageType;
    hideDetails?: boolean;
    defaultOpen?: boolean;
    toolOpen?: boolean;
    onToolOpenChange?: (open: boolean) => void;
    deferToolContent?: boolean;
    virtualizeDiff?: boolean;
    onContentRendered?: () => void;
    showAssistantCopyPartID?: string | null;
    turnDurationMs?: number;
    useV2Actions?: boolean;
}
export type PartComponent = Component<MessagePartProps>;
export declare const PART_MAPPING: Record<string, PartComponent | undefined>;
import type { IconProps } from "@opencode-ai/ui/icon";
export type ToolInfo = {
    icon: IconProps["name"];
    title: string;
    subtitle?: string;
};
export declare function getToolInfo(tool: string, input?: any, metadata?: Record<string, unknown> | undefined): ToolInfo;
export type PartRef = {
    messageID: string;
    partID: string;
};
export type PartGroup = {
    key: string;
    type: "part";
    ref: PartRef;
} | {
    key: string;
    type: "context";
    refs: PartRef[];
};
export declare function sameGroups(a: readonly PartGroup[] | undefined, b: readonly PartGroup[] | undefined): boolean;
export declare function groupParts(parts: {
    messageID: string;
    part: PartType;
}[]): PartGroup[];
export declare function renderable(part: PartType, showReasoningSummaries?: boolean): boolean;
export declare function partDefaultOpen(part: PartType, shell?: boolean, edit?: boolean): boolean | undefined;
export declare function AssistantParts(props: {
    messages: AssistantMessage[];
    showAssistantCopyPartID?: string | null;
    turnDurationMs?: number;
    useV2Actions?: boolean;
    working?: boolean;
    showReasoningSummaries?: boolean;
    shellToolDefaultOpen?: boolean;
    editToolDefaultOpen?: boolean;
}): JSX.Element;
export declare function registerPartComponent(type: string, component: PartComponent): void;
export declare function Message(props: MessageProps): JSX.Element;
export declare function AssistantMessageDisplay(props: {
    message: AssistantMessage;
    parts: PartType[];
    showAssistantCopyPartID?: string | null;
    showReasoningSummaries?: boolean;
    useV2Actions?: boolean;
}): JSX.Element;
export declare function ContextToolGroup(props: {
    parts: ToolPart[];
    busy?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    onSizeChange?: () => void;
}): JSX.Element;
export declare function UserMessageDisplay(props: {
    message: UserMessage;
    parts: PartType[];
    actions?: UserActions;
    useV2Actions?: boolean;
}): JSX.Element;
export declare function Part(props: MessagePartProps): JSX.Element;
export interface ToolProps {
    input: Record<string, any>;
    metadata: Record<string, any>;
    tool: string;
    sessionID?: string;
    output?: string;
    status?: string;
    hideDetails?: boolean;
    defaultOpen?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    deferContent?: boolean;
    virtualizeDiff?: boolean;
    onContentRendered?: () => void;
    forceOpen?: boolean;
    locked?: boolean;
}
export type ToolComponent = Component<ToolProps>;
export declare function registerTool(input: {
    name: string;
    render?: ToolComponent;
}): {
    name: string;
    render?: ToolComponent | undefined;
};
export declare function getTool(name: string): ToolComponent | undefined;
export declare const ToolRegistry: {
    register: typeof registerTool;
    render: typeof getTool;
};
export declare function MessageDivider(props: {
    label: string;
}): JSX.Element;
