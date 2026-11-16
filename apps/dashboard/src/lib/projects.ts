export interface Project {
  id: string;
  name: string;
  serviceIds: string[];
}
export interface ProjectList {
  projects: Project[];
}
