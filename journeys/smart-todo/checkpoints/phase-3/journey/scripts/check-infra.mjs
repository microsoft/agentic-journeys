#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WINDOWS_CLI_RUNNER = [
  "$ErrorActionPreference = 'Stop'",
  '$payload = ConvertFrom-Json -InputObject $env:AZURE_NATIVE_CLI_PAYLOAD',
  '$command = [string]$payload[0]',
  '$arguments = @($payload | Select-Object -Skip 1)',
  '$resolved = Get-Command -Name $command -ErrorAction Stop',
  '$target = [string]$resolved.Source',
  'if (-not $target) { $target = $command }',
  'foreach ($argument in $arguments) { if (([string]$argument).Contains([char]34)) { [Console]::Error.WriteLine("Arguments containing double quotes cannot be passed safely through Windows PowerShell."); exit 2 } }',
  'if ($target.EndsWith(".cmd", [System.StringComparison]::OrdinalIgnoreCase) -or $target.EndsWith(".bat", [System.StringComparison]::OrdinalIgnoreCase)) {',
  "  $unsafe = [char[]]'&|<>^%!()'",
  '  foreach ($argument in $arguments) { $text = [string]$argument; if ($text.IndexOfAny($unsafe) -ge 0 -or $text.Contains([char]10) -or $text.Contains([char]13)) { [Console]::Error.WriteLine("Arguments containing shell metacharacters or control characters cannot be passed safely to a Windows .cmd/.bat shim."); exit 2 } }',
  '}',
  '& $target @arguments',
  '$ok = $?',
  '$code = $LASTEXITCODE',
  'if ($null -ne $code) { exit $code }',
  'if (-not $ok) { exit 1 }',
].join('; ');

const scriptPath = fileURLToPath(import.meta.url);
const projectDirectory = path.resolve(path.dirname(scriptPath), '..');
const offline = process.argv.slice(2).includes('--offline');
const unexpectedArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== '--offline');

function projectPath(relativePath) {
  return path.resolve(projectDirectory, relativePath);
}

function buildInvocation(command, args, environment = process.env) {
  if (process.platform !== 'win32') {
    return { file: command, args, env: environment };
  }
  return {
    file: 'powershell.exe',
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_CLI_RUNNER,
    ],
    env: {
      ...environment,
      AZURE_NATIVE_CLI_PAYLOAD: JSON.stringify([command, ...args]),
    },
  };
}

function run(command, args, options = {}) {
  const invocation = buildInvocation(command, args, options.env);
  return spawnSync(invocation.file, invocation.args, {
    cwd: options.cwd ?? projectDirectory,
    encoding: 'utf8',
    env: invocation.env,
    shell: false,
    timeout: options.timeout ?? 120_000,
    windowsHide: true,
  });
}

function output(result) {
  return [result.stdout, result.stderr, result.error?.message]
    .filter(Boolean)
    .join('\n')
    .trim();
}

function concise(message) {
  return String(message).replace(/\s+/g, ' ').trim();
}

const results = [];

function pass(name, reason) {
  results.push(true);
  console.log(`PASS ${name}: ${reason}`);
}

function fail(name, reason) {
  results.push(false);
  console.log(`FAIL ${name}: ${concise(reason)}`);
}

function check(name, operation) {
  try {
    const reason = operation();
    pass(name, reason);
  } catch (error) {
    fail(name, error instanceof Error ? error.message : error);
  }
}

function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseYamlMappings(source) {
  const root = {};
  const stack = [{ indent: -1, value: root }];

  for (const rawLine of source.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    const indent = rawLine.match(/^ */)[0].length;
    const content = rawLine.trim();
    if (content.startsWith('- ')) {
      throw new Error('sequence syntax is not valid in the required azure.yaml');
    }
    const separator = content.indexOf(':');
    if (separator < 1) continue;
    const key = unquote(content.slice(0, separator));
    const rawValue = content.slice(separator + 1).trim();

    while (stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1).value;
    const value = rawValue ? unquote(rawValue.split(/\s+#/, 1)[0]) : {};
    parent[key] = value;
    if (!rawValue) stack.push({ indent, value });
  }

  return root;
}

function withoutBicepReleaseNotice(text) {
  return text
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/new (?:Bicep )?release is available/i.test(line) &&
        !/https:\/\/aka\.ms\/bicep/i.test(line),
    )
    .join('\n')
    .trim();
}

function collectResources(template, templateId = 'root', collection = []) {
  for (const [index, resource] of (template?.resources ?? []).entries()) {
    const entry = { resource, templateId };
    collection.push(entry);
    const nestedTemplate = resource?.properties?.template;
    if (nestedTemplate && typeof nestedTemplate === 'object') {
      collectResources(
        nestedTemplate,
        `${templateId}/${resource.name ?? resource.type ?? index}`,
        collection,
      );
    }
  }
  return collection;
}

function resourceBody(resource) {
  const body = {};
  for (const [key, value] of Object.entries(resource ?? {})) {
    if (key === 'metadata' || key === 'comments') continue;
    if (key === 'properties' && value?.template) {
      body[key] = { ...value };
      delete body[key].template;
      continue;
    }
    body[key] = value;
  }
  return body;
}

function walk(value, visitor, key = '', parent = null) {
  visitor(value, key, parent);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visitor, key, value);
  } else if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      if (
        childKey === 'metadata' ||
        childKey === 'comments' ||
        childKey === 'variables' ||
        childKey === 'outputs'
      ) {
        continue;
      }
      if (
        childValue &&
        typeof childValue === 'object' &&
        !Array.isArray(childValue) &&
        Object.hasOwn(childValue, 'type') &&
        Object.keys(childValue).every((name) =>
          ['type', 'defaultValue', 'allowedValues', 'metadata'].includes(name),
        )
      ) {
        continue;
      }
      walk(childValue, visitor, childKey, value);
    }
  }
}

function valuesForKey(body, wantedKey) {
  const values = [];
  walk(body, (value, key) => {
    if (key === wantedKey) values.push(value);
  });
  return values;
}

function scalarStrings(body) {
  const values = [];
  walk(body, (value) => {
    if (typeof value === 'string') values.push(value);
  });
  return values;
}

function containsLiteral(value, literal) {
  if (typeof value === 'string') {
    return value === literal || (value.startsWith('[') && value.includes(literal));
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsLiteral(item, literal));
  }
  if (value && typeof value === 'object') {
    if (
      Object.keys(value).length === 1 &&
      Object.hasOwn(value, 'value')
    ) {
      return containsLiteral(value.value, literal);
    }
    return Object.values(value).some((item) => containsLiteral(item, literal));
  }
  return value === literal;
}

function findObjects(body, predicate) {
  const matches = [];
  walk(body, (value) => {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      predicate(value)
    ) {
      matches.push(value);
    }
  });
  return matches;
}

function settingEntries(resources) {
  return resources.flatMap(({ resource }) =>
    findObjects(resourceBody(resource), (candidate) =>
      Object.hasOwn(candidate, 'name') && Object.hasOwn(candidate, 'value'),
    ),
  );
}

function hasSetting(entries, name) {
  return entries.some((entry) => containsLiteral(entry.name, name));
}

// Storage account names: 3-24 lowercase letters and digits. For an expression, check each
// quoted literal piece it concatenates, and the variable it names when that's a literal.
function storageNameProblems(template) {
  const problems = [];
  const variables = { ...(template?.variables ?? {}) };
  for (const { resource } of collectResources(template)) {
    const nested = resource?.properties?.template;
    if (nested?.variables) Object.assign(variables, nested.variables);
  }
  for (const { resource } of collectResources(template)) {
    if (resource?.type !== 'Microsoft.Storage/storageAccounts') continue;
    const name = resource.name;
    if (typeof name !== 'string') continue;
    if (!name.startsWith('[')) {
      if (!/^[a-z0-9]{3,24}$/.test(name)) problems.push(name);
      continue;
    }
    let expression = name;
    const variableRef = name.match(/^\[variables\('([^']+)'\)\]$/);
    if (variableRef && typeof variables[variableRef[1]] === 'string') expression = variables[variableRef[1]];
    // Only literal text is checked: a format() string without its {n} slots, and quoted
    // arguments to concat(). Names passed to variables()/parameters() aren't literals.
    const literals = [];
    const format = expression.match(/format\('([^']*)'/);
    if (format) literals.push(format[1].replace(/\{\d+\}/g, ''));
    const concat = expression.match(/concat\((.*)\)/);
    if (concat) for (const piece of concat[1].split(',')) {
      const quoted = piece.trim().match(/^'([^']*)'$/);
      if (quoted) literals.push(quoted[1]);
    }
    for (const text of literals) if (/[^a-z0-9]/.test(text)) problems.push(`${name} ('${text}')`);
  }
  return problems;
}

function checkContract(template) {
  const resources = collectResources(template);
  requireCondition(resources.length > 0, 'compiled template has no deployable resources');
  const badStorageNames = storageNameProblems(template);
  requireCondition(badStorageNames.length === 0, `storage account names must be 3-24 lowercase letters and digits: ${badStorageNames.join(', ')}`);
  const bodies = resources.map(({ resource }) => resourceBody(resource));
  const strings = bodies.flatMap(scalarStrings);
  const entries = settingEntries(resources);
  const outputNames = Object.keys(template.outputs ?? {});
  const requiredOutputs = [
    'API_URL',
    'SQL_SERVER_NAME',
    'SQL_DATABASE_NAME',
    'FUNCTION_APP_NAME',
    'AZURE_AI_ENDPOINT',
    'AZURE_AI_DEPLOYMENT',
    'RESOURCE_GROUP_NAME',
    'SQL_IDENTITY_NAME',
    'SQL_IDENTITY_CLIENT_ID',
  ];
  const missingOutputs = requiredOutputs.filter(
    (name) => !outputNames.includes(name),
  );
  requireCondition(
    missingOutputs.length === 0,
    `missing outputs: ${missingOutputs.join(', ')}`,
  );
  requireCondition(
    Object.values(template.outputs ?? {}).every(
      (definition) => !/\/api'\s*\]?$/.test(String(definition?.value ?? '')),
    ),
    'an output expression ends with /api',
  );

  const requiredSettings = [
    'DATA_PROVIDER',
    'AI_PROVIDER',
    'AZURE_AI_ENDPOINT',
    'AZURE_AI_DEPLOYMENT',
    'AZURE_SQL_SERVER',
    'AZURE_SQL_DATABASE',
    'AZURE_SQL_CLIENT_ID',
    'AzureWebJobsStorage__accountName',
  ];
  const missingSettings = requiredSettings.filter(
    (name) => !hasSetting(entries, name),
  );
  requireCondition(
    missingSettings.length === 0,
    `missing app settings: ${missingSettings.join(', ')}`,
  );
  requireCondition(
    !hasSetting(entries, 'FUNCTIONS_WORKER_RUNTIME'),
    'FUNCTIONS_WORKER_RUNTIME app setting is forbidden',
  );
  requireCondition(
    !hasSetting(entries, 'AZURE_AI_KEY'),
    'AZURE_AI_KEY app setting is forbidden: AI access is keyless',
  );
  requireCondition(
    entries.every((entry) => !/listKeys/i.test(JSON.stringify(entry.value ?? ''))),
    'app settings must not read keys with listKeys()',
  );
  const localAuthValues = bodies.flatMap((body) => valuesForKey(body, 'disableLocalAuth'));
  requireCondition(
    localAuthValues.some((value) => value === true),
    'the Foundry account must set disableLocalAuth to true',
  );
  requireCondition(
    localAuthValues.every((value) => value === true || (typeof value === 'string' && value.startsWith('['))),
    'literal disableLocalAuth must be true',
  );

  requireCondition(
    resources.some(({ resource }) =>
      containsLiteral(
        resource.type,
        'Microsoft.ManagedIdentity/userAssignedIdentities',
      ),
    ),
    'user-assigned managed identity resource is missing',
  );
  const functionApps = resources.filter(({ resource }) =>
    containsLiteral(resource.type, 'Microsoft.Web/sites'),
  );
  requireCondition(functionApps.length > 0, 'Function App resource is missing');
  requireCondition(
    functionApps.some(({ resource }) => {
      const identityTypes = valuesForKey(resourceBody(resource), 'type');
      return identityTypes.some(
        (value) =>
          typeof value === 'string' &&
          value.includes('SystemAssigned') &&
          value.includes('UserAssigned'),
      );
    }),
    'Function App identity must include SystemAssigned and UserAssigned',
  );

  for (const body of bodies) {
    for (const value of valuesForKey(body, 'zoneRedundant')) {
      if (typeof value !== 'string' || !value.startsWith('[')) {
        requireCondition(value === false, 'literal zoneRedundant must be false');
      }
    }
    for (const value of valuesForKey(body, 'alwaysOn')) {
      if (typeof value !== 'string' || !value.startsWith('[')) {
        requireCondition(value === false, 'literal alwaysOn must be false');
      }
    }
  }
  for (const { resource } of resources.filter(({ resource }) =>
    String(resource.type ?? '').toLowerCase().includes('microsoft.storage/'),
  )) {
    const body = resourceBody(resource);
    for (const value of valuesForKey(body, 'defaultAction')) {
      if (typeof value !== 'string' || !value.startsWith('[')) {
        requireCondition(value === 'Allow', 'literal storage defaultAction must be Allow');
      }
    }
    for (const value of valuesForKey(body, 'allowSharedKeyAccess')) {
      if (typeof value !== 'string' || !value.startsWith('[')) {
        requireCondition(
          value === false,
          'literal storage allowSharedKeyAccess must be false',
        );
      }
    }
  }

  for (const literal of ['FC1', 'deploymentpackage', 'azd-service-name', 'api']) {
    requireCondition(
      bodies.some((body) => containsLiteral(body, literal)),
      `required resource literal is missing: ${literal}`,
    );
  }
  requireCondition(
    bodies.some(
      (body) =>
        containsLiteral(body, 'gpt-5-mini') ||
        containsLiteral(body, 'gpt-4.1'),
    ),
    'required AI model deployment is missing',
  );

  const functionConfigs = bodies.flatMap((body) =>
    valuesForKey(body, 'functionAppConfig'),
  );
  requireCondition(functionConfigs.length > 0, 'functionAppConfig is missing');
  requireCondition(
    functionConfigs.some(
      (config) =>
        config &&
        Object.hasOwn(config, 'runtime') &&
        Object.hasOwn(config, 'scaleAndConcurrency') &&
        config.deployment?.storage,
    ),
    'functionAppConfig must include runtime, scaleAndConcurrency, and deployment.storage',
  );
  for (const config of functionConfigs) {
    if (config.runtime && !String(config.runtime.name).startsWith('[')) {
      requireCondition(config.runtime.name === 'node', 'runtime.name must be node');
    }
    const memory = config.scaleAndConcurrency?.instanceMemoryMB;
    if (memory !== undefined && !String(memory).startsWith('[')) {
      requireCondition(memory === 2048, 'instanceMemoryMB must be 2048');
    }
    const authentication = config.deployment?.storage?.authentication?.type;
    if (authentication !== undefined && !String(authentication).startsWith('[')) {
      requireCondition(
        authentication === 'SystemAssignedIdentity',
        'deployment storage authentication must be SystemAssignedIdentity',
      );
    }
  }

  const legacyStorageSettings = entries.filter((entry) =>
    containsLiteral(entry.name, 'AzureWebJobsStorage'),
  );
  requireCondition(
    legacyStorageSettings.every((entry) => {
      const value = String(entry.value ?? '');
      return !/(AccountKey|DefaultEndpointsProtocol|listKeys|connectionString)/i.test(
        value,
      );
    }),
    'AzureWebJobsStorage must not hold a connection string',
  );

  const firewallResources = resources.filter(({ resource }) =>
    String(resource.type ?? '').toLowerCase().includes('firewallrules'),
  );
  requireCondition(
    firewallResources.some(({ resource }) => {
      const body = resourceBody(resource);
      return (
        containsLiteral(resource.name, 'AllowAzureServices') &&
        containsLiteral(valuesForKey(body, 'startIpAddress'), '0.0.0.0') &&
        containsLiteral(valuesForKey(body, 'endIpAddress'), '0.0.0.0')
      );
    }),
    'AllowAzureServices firewall rule with 0.0.0.0 addresses is missing',
  );
  requireCondition(
    firewallResources.every(
      ({ resource }) => !/windows/i.test(String(resource.name ?? '')),
    ),
    'firewall rule names must not contain windows',
  );

  for (const roleDefinitionId of [
    'b7e6dc6d-f1e8-4753-8033-0f276bb0955b',
    'ba92f5b4-2d11-453d-a403-e96b0029c9fe',
    '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd',
  ]) {
    requireCondition(
      strings.some((value) =>
        value.toLowerCase().includes(roleDefinitionId.toLowerCase()),
      ),
      `role definition ID is missing: ${roleDefinitionId}`,
    );
  }

  const rawAccounts = resources.filter(({ resource }) =>
    containsLiteral(resource.type, 'Microsoft.CognitiveServices/accounts'),
  );
  const rawDeployments = resources.filter(({ resource }) =>
    containsLiteral(
      resource.type,
      'Microsoft.CognitiveServices/accounts/deployments',
    ),
  );
  for (const deployment of rawDeployments) {
    requireCondition(
      rawAccounts.every(
        (account) => account.templateId !== deployment.templateId,
      ),
      'raw AI account and model deployment must be in separate templates',
    );
  }

  return `${resources.length} deployable resources satisfy the compiled contract`;
}

if (unexpectedArguments.length > 0) {
  console.error(`Usage: node scripts/check-infra.mjs [--offline]`);
  process.exitCode = 1;
} else {
  const requiredFiles = [
    'azure.yaml',
    'infra/main.bicep',
    'infra/main.parameters.json',
    'infra/hooks/postprovision.js',
  ];

  check('Files', () => {
    const missing = requiredFiles.filter(
      (relativePath) => !existsSync(projectPath(relativePath)),
    );
    requireCondition(missing.length === 0, `missing ${missing.join(', ')}`);
    return 'all required infrastructure files exist';
  });

  check('azure.yaml', () => {
    const yamlPath = projectPath('azure.yaml');
    requireCondition(existsSync(yamlPath), 'azure.yaml does not exist');
    const yaml = parseYamlMappings(readFileSync(yamlPath, 'utf8'));
    const services = yaml.services ?? {};
    requireCondition(
      Object.keys(services).length === 1 && services.api,
      'services must contain exactly one service named api',
    );
    requireCondition(services.api.project === './src/api', 'api.project must be ./src/api');
    requireCondition(services.api.host === 'function', 'api.host must be function');
    requireCondition(services.api.language === 'ts', 'api.language must be ts');
    requireCondition(
      yaml.hooks?.postprovision?.run === './infra/hooks/postprovision.js',
      'hooks.postprovision.run must be ./infra/hooks/postprovision.js',
    );
    requireCondition(
      yaml.hooks?.postprovision?.shell !== 'sh',
      'hooks.postprovision must not use shell: sh',
    );
    return 'service and post-provision hook contract is valid';
  });

  check('Hook', () => {
    const hookPath = projectPath('infra/hooks/postprovision.js');
    requireCondition(existsSync(hookPath), 'infra/hooks/postprovision.js does not exist');
    const syntax = spawnSync(process.execPath, ['--check', hookPath], { encoding: 'utf8', shell: false, windowsHide: true });
    requireCondition(syntax.status === 0, output(syntax) || 'node --check failed');
    const source = readFileSync(hookPath, 'utf8');
    const forbidden = [
      [/\bcurl\b/i, 'curl'],
      [/\bgrep\b/i, 'grep'],
      [/shell\s*:\s*true/i, 'shell: true'],
      [/^\s*(?:import|export)\s/m, 'top-level import/export'],
      [/FROM\s+EXTERNAL\s+PROVIDER/i, 'FROM EXTERNAL PROVIDER'],
      [/\badministratorLoginPassword\b/i, 'administratorLoginPassword'],
      [/(?:^|[\s"'`,])\-U(?:[\s"'`,]|$)/m, '-U'],
      [/(?:^|[\s"'`,])--password(?:[\s"'`,]|$)/m, '--password'],
      [/\bCREATE\s+TABLE\b/i, 'CREATE TABLE'],
      [/\bINSERT\s+INTO\b/i, 'INSERT INTO'],
      [/\.sql(?:['"`\s]|$)/i, 'schema SQL file reference'],
    ];
    const found = forbidden
      .filter(([pattern]) => pattern.test(source))
      .map(([, label]) => label);
    requireCondition(found.length === 0, `forbidden hook content: ${found.join(', ')}`);
    requireCondition(
      !/firewall-rule[\s\S]{0,300}['"`]--yes['"`]/i.test(source),
      'firewall-rule command must not include --yes',
    );
    requireCondition(/\bTYPE\s*=\s*E\b/.test(source), 'hook must contain TYPE = E');

    const nodeOnlyEnvironment = {
      ...process.env,
      PATH: path.dirname(process.execPath),
    };
    // Run Node.js directly: the Windows launcher needs powershell.exe, which isn't on this PATH.
    const dryRun = spawnSync(process.execPath, [hookPath, '--dry-run'], {
      cwd: projectDirectory,
      encoding: 'utf8',
      env: nodeOnlyEnvironment,
      shell: false,
      timeout: 120_000,
      windowsHide: true,
    });
    requireCondition(
      dryRun.status === 0,
      output(dryRun) || 'hook --dry-run failed',
    );
    requireCondition(
      /\bDRY RUN\b/.test(dryRun.stdout ?? ''),
      'hook --dry-run did not print DRY RUN',
    );
    return 'syntax, source policy, and isolated dry-run passed';
  });

  check('Hook role grants are idempotent', () => {
    const source = readFileSync(
      projectPath('infra/hooks/postprovision.js'),
      'utf8',
    );
    for (const role of ['db_datareader', 'db_datawriter', 'db_ddladmin']) {
      const guardedGrant = new RegExp(
        `IF\\s+IS_ROLEMEMBER\\(N'${role}',[\\s\\S]{0,300}ALTER\\s+ROLE\\s+${role}\\s+ADD\\s+MEMBER`,
        'i',
      );
      requireCondition(
        guardedGrant.test(source),
        `${role} membership must be checked before it is granted`,
      );
    }
    return 'every SQL role membership is checked before ALTER ROLE';
  });

  check('Hook cleanup restores policy after firewall deletion failure', () => {
    const source = readFileSync(
      projectPath('infra/hooks/postprovision.js'),
      'utf8',
    );
    const finallyIndex = source.indexOf('} finally {');
    const deleteIndex = source.indexOf(
      "{ step: 'Delete temporary firewall rule' }",
      finallyIndex,
    );
    const restoreIndex = source.indexOf(
      "{ step: 'Restore SQL connection policy' }",
      deleteIndex,
    );
    requireCondition(
      finallyIndex >= 0 && deleteIndex > finallyIndex && restoreIndex > deleteIndex,
      'cleanup must delete the firewall rule and then restore the connection policy in finally',
    );
    const betweenCleanupSteps = source.slice(deleteIndex, restoreIndex);
    requireCondition(
      /catch\s*\(/.test(betweenCleanupSteps),
      'firewall deletion failure must be caught before policy restoration',
    );
    requireCondition(
      /let\s+setupError\b/.test(source) &&
        /catch\s*\(\s*error\s*\)\s*{\s*setupError\s*=\s*error\s*;/s.test(source) &&
        /AggregateError/.test(source.slice(restoreIndex)),
      'cleanup must preserve and report the original setup failure',
    );
    return 'cleanup attempts both operations and preserves the setup failure';
  });

  check('App Service plan name stays bounded without renaming existing plans', () => {
    const source = readFileSync(
      projectPath('infra/modules/resources.bicep'),
      'utf8',
    );
    const boundedName = source.match(
      /^var boundedPlanEnvironmentName = take\(environmentName, (\d+)\)$/m,
    );
    const planName = source.match(/^var planName = (.+)$/m)?.[1] ?? '';
    requireCondition(
      boundedName &&
        Number(boundedName[1]) <= 21 &&
        planName.includes('${boundedPlanEnvironmentName}') &&
        planName.includes('${resourceToken}') &&
        !planName.includes('${compactEnvironmentName}') &&
        !planName.includes('${environmentName}'),
      'planName must preserve short environment names and truncate only names that would exceed 40 characters',
    );
    return 'planName preserves existing short names and cannot exceed the 40-character limit';
  });

  check('AI model version is configured for the selected region', () => {
    const mainSource = readFileSync(projectPath('infra/main.bicep'), 'utf8');
    const resourcesSource = readFileSync(
      projectPath('infra/modules/resources.bicep'),
      'utf8',
    );
    const parameters = JSON.parse(
      readFileSync(projectPath('infra/main.parameters.json'), 'utf8'),
    );
    requireCondition(
      /\bparam modelVersion string\b/.test(mainSource) &&
        /\bmodelVersion:\s*modelVersion\b/.test(mainSource),
      'main.bicep must accept and pass modelVersion',
    );
    requireCondition(
      /\bparam modelVersion string\b/.test(resourcesSource) &&
        /\bmodelVersion:\s*modelVersion\b/.test(resourcesSource) &&
        !/\bmodelVersion:\s*'[^']+'/.test(resourcesSource),
      'resources.bicep must pass the configured modelVersion without a regional hard-code',
    );
    requireCondition(
      parameters.parameters?.modelVersion?.value ===
        '${AZURE_AI_MODEL_VERSION}',
      'main.parameters.json must map modelVersion from AZURE_AI_MODEL_VERSION',
    );
    return 'modelVersion is threaded from the azd environment to the deployment';
  });

  let compiledTemplate;
  check('Build', () => {
    const bicepPath = projectPath('infra/main.bicep');
    requireCondition(existsSync(bicepPath), 'infra/main.bicep does not exist');
    const build = run('az', ['bicep', 'build', '--file', bicepPath, '--stdout']);
    requireCondition(build.status === 0, output(build) || 'Bicep build failed');
    const diagnostics = withoutBicepReleaseNotice(build.stderr ?? '');
    requireCondition(
      !/\bwarning\b/i.test(diagnostics),
      `Bicep build reported warnings: ${diagnostics}`,
    );
    try {
      compiledTemplate = JSON.parse(build.stdout);
    } catch (error) {
      throw new Error(`Bicep build did not print valid JSON: ${error.message}`);
    }
    return 'Bicep compiled to valid JSON without warnings';
  });

  check('Lint', () => {
    const bicepPath = projectPath('infra/main.bicep');
    requireCondition(existsSync(bicepPath), 'infra/main.bicep does not exist');
    const lint = run('az', ['bicep', 'lint', '--file', bicepPath]);
    const diagnostics = withoutBicepReleaseNotice(output(lint));
    requireCondition(lint.status === 0, diagnostics || 'Bicep lint failed');
    requireCondition(
      !/\b(?:warning|error)\b/i.test(diagnostics),
      `Bicep lint reported diagnostics: ${diagnostics}`,
    );
    return 'Bicep lint passed without warnings or errors';
  });

  check('Contract rules', () => {
    requireCondition(compiledTemplate, 'compiled template is unavailable because Build failed');
    return checkContract(compiledTemplate);
  });

  check('Preview', () => {
    if (offline) return 'skipped by --offline';
    const requiredEnvironmentValues = [
      'AZURE_SUBSCRIPTION_ID',
      'AZURE_PRINCIPAL_ID',
      'AZURE_PRINCIPAL_LOGIN',
      'AZURE_PRINCIPAL_TYPE',
    ];
    const missing = [];
    for (const name of requiredEnvironmentValues) {
      const value = run('azd', ['env', 'get-value', name]);
      if (value.status !== 0 || !(value.stdout ?? '').trim()) missing.push(name);
    }
    requireCondition(
      missing.length === 0,
      `selected azd environment is missing: ${missing.join(', ')}`,
    );
    const preview = run('azd', ['provision', '--preview', '--no-prompt'], {
      timeout: 600_000,
    });
    requireCondition(preview.status === 0, output(preview) || 'azd preview failed');
    return 'azd provision preview passed';
  });

  process.exitCode = results.every(Boolean) ? 0 : 1;
}
