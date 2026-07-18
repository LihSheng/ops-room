import { useQuery } from '@tanstack/react-query';
import { skillsApi, type SkillsCatalogResponse } from '../api/skills';

export function useSkills() {
  return useQuery<SkillsCatalogResponse>({
    queryKey: ['skills-catalog'],
    queryFn: () => skillsApi.list(),
    refetchInterval: 30_000,
  });
}
