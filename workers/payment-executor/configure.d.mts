export interface PaymentStackInput {
  stack?: "test" | "production";
  network: string;
  databaseId?: string;
  databaseName?: string;
  deployments: unknown;
  registry: unknown;
  registryDatabase: { database_name: string; database_id: string };
  executionEnabled?: (network: string) => boolean;
}
export interface PaymentStackConfig {
  name: string;
  vars: Record<string, string>;
  services?: { binding: string; service: string }[];
  d1_databases: {
    binding: string;
    database_name: string;
    database_id: string;
    migrations_dir?: string;
  }[];
  triggers?: { crons: string[] };
}
export declare function paymentStack(input: PaymentStackInput): {
  names: Record<"attester" | "relayer" | "dispatcher", string>;
  configs: Record<"attester" | "relayer" | "dispatcher", PaymentStackConfig>;
  secret: string;
};
