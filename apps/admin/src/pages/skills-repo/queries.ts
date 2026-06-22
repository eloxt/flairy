import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query'
import type { SkillConfig, SkillInput } from '@flairy/shared'

import {
  createSkill,
  deleteSkill,
  getSkill,
  listSkills,
  updateSkill,
  uploadSkillFile
} from '@/api/client'
import type {
  ListSkillsParams,
  ListSkillsResponse,
  UploadFileResponse
} from '@/lib/types/skills'

/**
 * TanStack Query hooks over the plain-fetch API client. Mirrors Bifrost's RTK
 * Query endpoints: `providesTags`/`invalidatesTags` map to `queryKey` /
 * `invalidateQueries(['skills'])`. All skill mutations bump the server's global
 * config version, so a socket `config:updated` listener can also invalidate.
 */

export const skillsKeys = {
  all: ['skills'] as const,
  list: (params?: ListSkillsParams) => ['skills', 'list', params ?? {}] as const,
  detail: (id: string) => ['skills', 'detail', id] as const
}

export function useListSkills(params?: ListSkillsParams): UseQueryResult<ListSkillsResponse> {
  return useQuery({
    queryKey: skillsKeys.list(params),
    queryFn: () => listSkills(params)
  })
}

export function useGetSkill(
  id: string | null | undefined
): UseQueryResult<SkillConfig> {
  return useQuery({
    queryKey: skillsKeys.detail(id ?? ''),
    queryFn: () => getSkill(id as string),
    enabled: !!id
  })
}

export function useCreateSkill(): UseMutationResult<SkillConfig, Error, SkillInput> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: SkillInput) => createSkill(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: skillsKeys.all })
    }
  })
}

export function useUpdateSkill(): UseMutationResult<
  SkillConfig,
  Error,
  { id: string; data: SkillInput }
> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: SkillInput }) => updateSkill(id, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: skillsKeys.all })
    }
  })
}

export function useDeleteSkill(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteSkill(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: skillsKeys.all })
    }
  })
}

export function useUploadSkillFile(): UseMutationResult<UploadFileResponse, Error, File> {
  return useMutation({
    mutationFn: (file: File) => uploadSkillFile(file)
  })
}
