import { HARNESSES, type HarnessInventory, type HarnessFolder, type ModelsInventory, type McpsInventory } from '../../shared/types'
import { createInventoryResource } from './inventoryResource'

export const emptyHarnesses: HarnessFolder[] = HARNESSES.map(harness => ({ id: harness.id, name: harness.name, path: `~/${harness.directory}`, skillsPath: `~/${harness.directory}/skills`, exists: false, skills: [] }))
export const agentsResource = createInventoryResource<HarnessInventory>({ agentsSource: { path: '~/.claude/CLAUDE.md', exists: false }, harnesses: emptyHarnesses }, () => window.wide!.harnessInventory(false))
export const skillsResource = createInventoryResource<HarnessFolder[]>(emptyHarnesses, () => window.wide!.harnessSkillsInventory())
export const modelsResource = createInventoryResource<ModelsInventory>({ sources: [] }, () => window.wide!.modelsInventory())
export const mcpsResource = createInventoryResource<McpsInventory>({ sources: [] }, () => window.wide!.mcpsInventory())
