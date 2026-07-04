import { type Accessor, type JSX } from "solid-js";
import type { IconProps } from "@opencode-ai/ui/icon";
export type TriggerTitle = {
    title: string;
    titleClass?: string;
    subtitle?: string;
    subtitleClass?: string;
    args?: string[];
    argsClass?: string;
    action?: JSX.Element;
};
export interface BasicToolProps {
    icon: IconProps["name"];
    trigger: TriggerTitle | JSX.Element | ((open: Accessor<boolean>) => JSX.Element);
    children?: JSX.Element;
    status?: string;
    hideDetails?: boolean;
    defaultOpen?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    forceOpen?: boolean;
    defer?: boolean;
    locked?: boolean;
    animated?: boolean;
    onSubtitleClick?: () => void;
    onTriggerClick?: JSX.EventHandlerUnion<HTMLElement, MouseEvent>;
    onTriggerKeyDown?: JSX.EventHandlerUnion<HTMLElement, KeyboardEvent>;
    triggerHref?: string;
    triggerAsLink?: boolean;
    clickable?: boolean;
}
export declare function BasicTool(props: BasicToolProps): JSX.Element;
export declare function GenericTool(props: {
    tool: string;
    status?: string;
    hideDetails?: boolean;
    input?: Record<string, unknown>;
}): JSX.Element;
