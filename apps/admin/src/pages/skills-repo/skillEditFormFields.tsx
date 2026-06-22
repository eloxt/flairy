import type { SkillConfig } from '@flairy/shared'
import { composeFrontmatter } from './helpers'
import { SkillReadOnlyContent } from './shared'
import type { SkillFileEntry } from '@/lib/types/skills'

function hasKeys(
  obj: Record<string, unknown> | null | undefined
): obj is Record<string, unknown> {
  return obj != null && Object.keys(obj).length > 0
}

export function SkillFormFields({ skill }: { skill: SkillConfig }): React.JSX.Element {
  const extraFrontmatter = hasKeys(skill.extraFrontmatter) ? skill.extraFrontmatter : null
  const metadata = hasKeys(skill.metadata) ? skill.metadata : null

  return (
    <SkillReadOnlyContent
      className="min-h-0 flex-1"
      skillId={skill.id}
      skillName={skill.name}
      skillMdBody={skill.skillMdBody}
      files={(skill.files ?? []) as SkillFileEntry[]}
      extraFrontmatter={extraFrontmatter}
      metadata={metadata}
      composedSkillMd={
        composeFrontmatter({
          name: skill.name,
          description: skill.description,
          license: skill.license || '',
          compatibility: skill.compatibility || '',
          allowed_tools: skill.allowedTools || '',
          extra_frontmatter_json: extraFrontmatter
            ? JSON.stringify(extraFrontmatter, null, 2)
            : '',
          metadata_json: metadata ? JSON.stringify(metadata, null, 2) : ''
        }) +
        '\n\n' +
        skill.skillMdBody
      }
    />
  )
}
