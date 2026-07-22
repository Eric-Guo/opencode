import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstallationDatabase } from "@/installation/database"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"

const bootstrapReplacement = [InstanceStore.bootstrapNode, InstanceBootstrap.node] as const
const databaseReplacement = [Database.node, Database.configured({ path: InstallationDatabase.path() })] as const

export function build<A, E>(root: LayerNode.Node<A, E, any>, replacements: LayerNode.Replacements = []) {
  return AppNodeBuilder.build(root, replacements.concat([bootstrapReplacement, databaseReplacement]))
}

export * as AppNodeBuilderV1 from "./app-node-builder-v1"
