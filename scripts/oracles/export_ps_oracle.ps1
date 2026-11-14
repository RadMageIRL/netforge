# Reads NetForge's generated PowerShell export scripts with Windows PowerShell's own parser and
# writes tests/fixtures/export-ps-oracle.json. Nothing is run: every script is only parsed, and
# what the parser found is recorded (commands, parameters, the string values it reads, hashtable
# entries, #Requires statements, and counts of constructs that could evaluate code).
#
#   NETFORGE_WRITE_EXPORT_PS_CASES=<cases.json> npx vitest run tests/unit/export-powershell-oracle.test.ts
#   powershell -NoProfile -File scripts/oracles/export_ps_oracle.ps1 <cases.json> tests/fixtures/export-ps-oracle.json
#
# If the DhcpServer module (RSAT) is installed, the parameter names of its four cmdlets are
# recorded from command metadata, without invoking them. Nothing is installed when it is missing.
param([Parameter(Mandatory = $true)][string]$CasesPath, [Parameter(Mandatory = $true)][string]$OutPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$casesDoc = [System.IO.File]::ReadAllText((Resolve-Path $CasesPath), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$results = New-Object System.Collections.ArrayList
$sha = [System.Security.Cryptography.SHA256]::Create()
$utf8 = New-Object System.Text.UTF8Encoding $false

function Read-Value($node) {
  # A value as the parser read it: a string constant (bare word or quoted), a list of them, a
  # number, $null, or the name of any other node type.
  if ($node -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
    return [ordered]@{ t = $node.StringConstantType.ToString(); v = @($node.Value) }
  }
  if ($node -is [System.Management.Automation.Language.ArrayLiteralAst]) {
    $values = New-Object System.Collections.ArrayList
    $types = New-Object System.Collections.ArrayList
    foreach ($e in $node.Elements) {
      if ($e -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
        [void]$values.Add($e.Value)
        if (-not $types.Contains($e.StringConstantType.ToString())) { [void]$types.Add($e.StringConstantType.ToString()) }
      } else {
        return [ordered]@{ t = "ArrayOf:$($e.GetType().Name)"; v = @() }
      }
    }
    return [ordered]@{ t = ($types -join '+'); v = @($values) }
  }
  if ($node -is [System.Management.Automation.Language.ConstantExpressionAst]) {
    return [ordered]@{ t = 'Number'; v = @($node.Value.ToString()) }
  }
  if ($node -is [System.Management.Automation.Language.VariableExpressionAst]) {
    return [ordered]@{ t = 'Variable'; v = @($node.VariablePath.UserPath) }
  }
  if ($node -is [System.Management.Automation.Language.ParenExpressionAst]) {
    # ('text'): one quoted string in parentheses, which is how the stop-parsing token is written.
    $p = $node.Pipeline
    if ($p -is [System.Management.Automation.Language.PipelineAst] -and $p.PipelineElements.Count -eq 1 -and $p.PipelineElements[0] -is [System.Management.Automation.Language.CommandExpressionAst]) {
      $inner = $p.PipelineElements[0].Expression
      if ($inner -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
        return [ordered]@{ t = "Paren:$($inner.StringConstantType)"; v = @($inner.Value) }
      }
    }
  }
  return [ordered]@{ t = $node.GetType().Name; v = @() }
}

function Read-ArrayExpression($node) {
  # @( ... ) holding nothing, one string or a list of strings.
  $statements = @($node.SubExpression.Statements)
  if ($statements.Count -eq 0) { return [ordered]@{ t = 'Array'; v = @() } }
  if ($statements.Count -ne 1) { return [ordered]@{ t = 'ArrayWithStatements'; v = @() } }
  $pipeline = $statements[0]
  if ($pipeline -isnot [System.Management.Automation.Language.PipelineAst] -or $pipeline.PipelineElements.Count -ne 1 -or $pipeline.PipelineElements[0] -isnot [System.Management.Automation.Language.CommandExpressionAst]) {
    return [ordered]@{ t = 'ArrayWithPipeline'; v = @() }
  }
  $inner = Read-Value $pipeline.PipelineElements[0].Expression
  if ($inner.t -ne 'SingleQuoted') { return [ordered]@{ t = "ArrayOf:$($inner.t)"; v = @() } }
  return [ordered]@{ t = 'Array'; v = @($inner.v) }
}

$count = { param($ast, [string]$typeName) @($ast.FindAll({ param($n) $n.GetType().Name -eq $typeName }.GetNewClosure(), $true)).Count }

foreach ($case in $casesDoc.cases) {
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($case.text, [ref]$tokens, [ref]$errors)
  $parseErrors = @($errors | ForEach-Object { $_.Message })

  $commands = New-Object System.Collections.ArrayList
  foreach ($cmd in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)) {
    $params = New-Object System.Collections.ArrayList
    $current = $null
    $elements = $cmd.CommandElements
    for ($i = 1; $i -lt $elements.Count; $i++) {
      $e = $elements[$i]
      if ($e -is [System.Management.Automation.Language.CommandParameterAst]) {
        $current = [ordered]@{ p = $e.ParameterName; t = 'Switch'; v = @() }
        if ($null -ne $e.Argument) { $current.t = 'Colon' }
        [void]$params.Add($current)
      } else {
        $value = Read-Value $e
        if ($null -eq $current -or $current.t -ne 'Switch') {
          [void]$params.Add([ordered]@{ p = ''; t = "Positional:$($value.t)"; v = $value.v })
        } else {
          $current.t = $value.t
          $current.v = $value.v
        }
      }
    }
    [void]$commands.Add([ordered]@{ name = $cmd.GetCommandName(); params = @($params) })
  }

  $tables = New-Object System.Collections.ArrayList
  foreach ($table in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.HashtableAst] }, $true)) {
    $entries = New-Object System.Collections.ArrayList
    foreach ($pair in $table.KeyValuePairs) {
      $key = Read-Value $pair.Item1
      $statement = $pair.Item2
      $value = [ordered]@{ t = $statement.GetType().Name; v = @() }
      if ($statement -is [System.Management.Automation.Language.PipelineAst] -and $statement.PipelineElements.Count -eq 1 -and $statement.PipelineElements[0] -is [System.Management.Automation.Language.CommandExpressionAst]) {
        $expression = $statement.PipelineElements[0].Expression
        if ($expression -is [System.Management.Automation.Language.ArrayExpressionAst]) { $value = Read-ArrayExpression $expression } else { $value = Read-Value $expression }
      }
      [void]$entries.Add([ordered]@{ k = $key.v[0]; kt = $key.t; t = $value.t; v = $value.v })
    }
    [void]$tables.Add(@($entries))
  }

  $requires = $null
  if ($null -ne $ast.ScriptRequirements) {
    $r = $ast.ScriptRequirements
    $requires = [ordered]@{
      version = $(if ($null -ne $r.RequiredPSVersion) { $r.RequiredPSVersion.ToString() } else { $null })
      modules = @($r.RequiredModules | ForEach-Object { $_.Name })
      elevation = [bool]$r.IsElevationRequired
    }
  }

  $observed = [ordered]@{
    id = $case.id
    sha256 = (-join ($sha.ComputeHash($utf8.GetBytes($case.text)) | ForEach-Object { $_.ToString('x2') }))
    parseErrors = $parseErrors
    commands = @($commands)
    tables = @($tables)
    requires = $requires
    assignments = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true) | ForEach-Object { $_.Left.Extent.Text })
    typeNames = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.TypeExpressionAst] -or $n -is [System.Management.Automation.Language.ConvertExpressionAst] }, $true) | ForEach-Object { if ($_ -is [System.Management.Automation.Language.ConvertExpressionAst]) { $_.Type.TypeName.FullName } else { $_.TypeName.FullName } })
    risky = [ordered]@{
      expandableStrings = (& $count $ast 'ExpandableStringExpressionAst')
      subExpressions = (& $count $ast 'SubExpressionAst')
      methodCalls = (& $count $ast 'InvokeMemberExpressionAst')
      scriptBlocks = (& $count $ast 'ScriptBlockExpressionAst')
      usingExpressions = (& $count $ast 'UsingExpressionAst')
      redirections = (& $count $ast 'FileRedirectionAst')
    }
  }
  [void]$results.Add($observed)
}

# Parameter names of the DhcpServer cmdlets, from metadata only, when the module is installed.
$dhcpParameters = $null
$names = @('Add-DhcpServerv4Scope', 'Add-DhcpServerv4ExclusionRange', 'Set-DhcpServerv4OptionValue', 'Add-DhcpServerv4Reservation')
if ($null -ne (Get-Module -ListAvailable -Name DhcpServer)) {
  $dhcpParameters = [ordered]@{}
  foreach ($n in $names) { $dhcpParameters[$n] = @((Get-Command -Name $n -Module DhcpServer).Parameters.Keys | Sort-Object) }
}

$fixture = [ordered]@{
  source = 'Windows PowerShell parser (System.Management.Automation.Language.Parser); nothing was run'
  powershell = $PSVersionTable.PSVersion.ToString()
  os = [System.Environment]::OSVersion.Version.ToString()
  dhcpServerModuleInstalled = ($null -ne $dhcpParameters)
  dhcpServerParameters = $dhcpParameters
  cases = @($results)
}
$json = $fixture | ConvertTo-Json -Depth 12 -Compress
[System.IO.File]::WriteAllText($OutPath, $json + "`n", (New-Object System.Text.UTF8Encoding $false))
Write-Output "Parsed $($results.Count) scripts with PowerShell $($PSVersionTable.PSVersion); DhcpServer module installed: $($null -ne $dhcpParameters) -> $OutPath"
