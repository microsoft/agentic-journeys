---
name: flex-functions-sql-foundry
description: |
  Scaffold and deploy an Azure Functions Flex Consumption API with Azure SQL through managed identity and Microsoft Foundry.
  USE FOR: serverless APIs that need Flex Consumption, managed-identity Azure SQL access, Microsoft Foundry models, and deterministic azd/Bicep infrastructure.
  DO NOT USE FOR: Container Apps, AKS, SQL password authentication, non-HTTP workloads that need independent scaling, or projects that cannot use Azure CLI and azd.
---

# Flex Functions with SQL and Foundry

## When to Use

Use this skill for an Azure Functions Flex Consumption API that connects to
Azure SQL through managed identity and calls a Microsoft Foundry model.

## Required Inputs

Collect these before generating infrastructure:

- Application name: 3-31 lowercase letters, numbers, and hyphens, starting with a letter
- Runtime language: an azd-supported value such as `ts`, `python`, `csharp`, or `java`
- Azure region: verify SQL and model availability there
- Foundry model name and region-supported model version

Also resolve the deploying principal's ID, login, and type (`User` or
`ServicePrincipal`) before provisioning. Never guess missing identity values.

## Fast Path and Gate

1. Run `node scripts/scaffold-infra.mjs --target <directory> --name <app-name>`.
2. Generate only application code or infrastructure changes the scaffold does not cover.
3. Run `node scripts/check-infra.mjs --offline`.
4. Do not deploy until the gate passes.
5. Set the azd subscription, location, region-specific `AZURE_AI_MODEL_VERSION`,
   principal ID, login, and type values.
6. Run `node scripts/check-infra.mjs` before `azd up`.

The scaffold and gate use only Node.js standard-library APIs and work from any
current directory. Do not copy `.azure/`, `.env` files, `node_modules/`, or
compiled Bicep JSON into a new project.

## Resource Contract

- One azd service named `api`, hosted on Azure Functions; device clients are not services.
- Flex Consumption App Service plan with SKU `FC1`.
- Function App with system-assigned identity for runtime/deployment storage and a
  user-assigned identity used only for Azure SQL.
- `functionAppConfig` with a supported runtime, 2048 MB memory, maximum instance
  count, and `deploymentpackage` blob storage authenticated by system identity.
- Storage with shared-key access disabled, default network action `Allow`, and a
  `deploymentpackage` container.
- Grant the Function App `Storage Blob Data Owner`; grant the deployer
  `Storage Blob Data Contributor`; grant the Function App's system identity
  `Cognitive Services OpenAI User` on the Foundry account.
- Azure SQL server with the deployer as Entra admin, an `AllowAzureServices`
  `0.0.0.0` firewall rule, and a Basic 2 GB database with zone redundancy off.
- A post-provision JavaScript hook creates the SQL identity user by client-ID SID,
  idempotently grants reader, writer, and DDL admin roles, attempts every cleanup
  action even after a cleanup failure, and never uses a SQL password.
- Microsoft Foundry/Azure OpenAI with local auth disabled (keyless) and the
  selected model; use `GlobalStandard` for `gpt-5-mini`.
- Log Analytics and Application Insights.
- Function settings for SQL and AI providers, endpoints, deployment, SQL
  FQDN/database/client ID (no AI key and no `listKeys()`), and identity-based `AzureWebJobsStorage__accountName`.
  Do not set `FUNCTIONS_WORKER_RUNTIME`; set `siteConfig.alwaysOn` to `false`.
- Outputs use `SCREAMING_SNAKE_CASE`; `API_URL` is the origin without `/api`.
- Add the `azd-service-name: api` tag to the Function App.

## Known Deployment Gotchas

- SQL and model availability varies by region. Try `westus3`, `centralus`, or
  `southcentralus` when needed, and query the region for the exact model version.
- Basic Azure SQL rejects zone redundancy and limits `maxSizeBytes` to 2 GB.
- SQL's Entra admin principal type is `User` or `Application`; map azd
  `ServicePrincipal` to `Application`. Avoid reserved words such as `WINDOWS` in names.
- Use the SQL server resource's FQDN. Appending the Azure suffix incorrectly can
  produce a double dot, while a short name causes DNS failures.
- For local SQL setup, temporarily add a developer-IP firewall rule. Switch a
  `Redirect` connection policy to `Proxy` if outbound ports 11000-11999 are
  blocked, and restore the policy and delete the rule in `finally`.
- Storage deployment failures usually mean the default action is not `Allow`, the
  deployer lacks Blob Data Contributor, or `deploymentpackage` is missing.
- Create a raw Cognitive Services model deployment in a separate nested module
  after its account to avoid `RequestConflict`.
- Flex Consumption rejects `alwaysOn: true` and a duplicate
  `FUNCTIONS_WORKER_RUNTIME` setting.
- Oryx TypeScript builds need `src/` and `tsconfig.json`; do not exclude them.
- Invoke hooks through argument arrays. On Windows, use a static PowerShell
  JSON-payload launcher so `.cmd` Azure CLI shims work safely.
- Simulator `Application failed preflight checks` or `SBMainWorkspace Busy`
  errors require terminating or uninstalling the app, rebooting the simulator,
  then cleaning and rebuilding.

Never print secrets, connection strings, app-setting values, developer IPs, or
run-specific subscription, principal, or resource identifiers.
