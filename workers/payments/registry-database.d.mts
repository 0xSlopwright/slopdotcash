export interface RegistryDatabase {
  database_name: string;
  database_id: string;
}
export function parseRegistryDatabase(toml: string): RegistryDatabase;
export function readRegistryDatabase(): Promise<RegistryDatabase>;
