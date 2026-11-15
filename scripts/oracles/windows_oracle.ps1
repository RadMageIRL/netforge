# Checks NetForge's generated PowerShell with Windows PowerShell itself and writes
# tests/fixtures/windows-oracle.json.
#
#   powershell -NoProfile -File scripts/oracles/windows_oracle.ps1 <cases.json> <fixture.json>
#
# For each script:
# 1. PowerShell's parser reads it (nothing runs). Parse errors are recorded, and the string values
#    PowerShell finds for -TaskName, -Execute and -Argument are recorded.
# 2. The trigger lines (everything before the "$action =" line) run in a fresh runspace, but only
#    after the syntax tree shows that every command in them is New-ScheduledTaskTrigger or
#    New-TimeSpan. They build an in-memory trigger object; nothing is registered with Task
#    Scheduler. The registration lines are never run.
param([Parameter(Mandatory = $true)][string]$CasesPath, [Parameter(Mandatory = $true)][string]$OutPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$allowed = @('New-ScheduledTaskTrigger', 'New-TimeSpan')
$casesDoc = [System.IO.File]::ReadAllText((Resolve-Path $CasesPath), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$results = New-Object System.Collections.ArrayList

function Get-ParameterString($ast, [string]$command, [string]$parameter) {
  $cmd = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq $command }, $true) | Select-Object -First 1
  if ($null -eq $cmd) { return $null }
  $elements = $cmd.CommandElements
  for ($i = 0; $i -lt $elements.Count; $i++) {
    $e = $elements[$i]
    if ($e -is [System.Management.Automation.Language.CommandParameterAst] -and $e.ParameterName -eq $parameter) {
      $value = $elements[$i + 1]
      # ('text') is an expression holding one constant string: read the string inside it.
      if ($value -is [System.Management.Automation.Language.ParenExpressionAst]) {
        $inner = @($value.FindAll({ param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] }, $true))
        $all = @($value.FindAll({ param($n) $n -is [System.Management.Automation.Language.ExpressionAst] -and $n -ne $value }, $true))
        if ($inner.Count -eq 1 -and $all.Count -eq 1 -and $inner[0].StringConstantType -eq 'SingleQuoted') { return $inner[0].Value }
        return "NOT A CONSTANT: $($value.Extent.Text)"
      }
      if ($value -is [System.Management.Automation.Language.StringConstantExpressionAst]) { return $value.Value }
      return "NOT A CONSTANT: $($value.GetType().Name)"
    }
  }
  return $null
}

foreach ($case in $casesDoc.cases) {
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($case.text, [ref]$tokens, [ref]$errors)
  $parseErrors = @($errors | ForEach-Object { $_.Message })

  $lines = $case.text -split "`n"
  $cut = 0
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i].StartsWith('$action =')) { $cut = $i; break } }
  $triggerText = ($lines[0..($cut - 1)] -join "`n")
  $tAst = [System.Management.Automation.Language.Parser]::ParseInput($triggerText, [ref]$tokens, [ref]$errors)
  $commands = @($tAst.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() })
  $invokes = @($tAst.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true))
  foreach ($c in $commands) { if ($allowed -notcontains $c) { throw "Case $($case.id): refusing to run command '$c'" } }
  if ($invokes.Count -gt 0) { throw "Case $($case.id): refusing to run method calls" }

  $ps = [PowerShell]::Create()
  [void]$ps.AddScript($triggerText + "`n" + '$trigger')
  $trigger = $ps.Invoke() | Select-Object -Last 1
  if ($ps.HadErrors) { throw "Case $($case.id): $($ps.Streams.Error | Out-String)" }
  $ps.Dispose()

  $prop = { param($name) if ($trigger.CimInstanceProperties[$name]) { $trigger.CimInstanceProperties[$name].Value } else { $null } }
  $rep = $trigger.Repetition
  $observed = [ordered]@{
    id = $case.id
    text = $case.text
    parseErrors = $parseErrors
    commands = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() })
    pipelines = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.PipelineAst] -and $n.PipelineElements.Count -gt 1 }, $true)).Count
    actionElements = @(($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'New-ScheduledTaskAction' }, $true) | Select-Object -First 1).CommandElements).Count
    registerElements = @(($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Register-ScheduledTask' }, $true) | Select-Object -First 1).CommandElements).Count
    strings = [ordered]@{
      TaskName = (Get-ParameterString $ast 'Register-ScheduledTask' 'TaskName')
      Execute = (Get-ParameterString $ast 'New-ScheduledTaskAction' 'Execute')
      Argument = (Get-ParameterString $ast 'New-ScheduledTaskAction' 'Argument')
    }
    trigger = [ordered]@{
      CimClassName = $trigger.CimClass.CimClassName
      StartBoundary = $trigger.StartBoundary
      DaysInterval = (& $prop 'DaysInterval')
      WeeksInterval = (& $prop 'WeeksInterval')
      DaysOfWeek = (& $prop 'DaysOfWeek')
      Interval = $(if ($rep) { $rep.Interval } else { $null })
      Duration = $(if ($rep) { $rep.Duration } else { $null })
      StopAtDurationEnd = $(if ($rep -and $rep.Interval) { [bool]$rep.StopAtDurationEnd } else { $null })
    }
  }
  [void]$results.Add($observed)
}

$fixture = [ordered]@{
  source = 'Windows PowerShell parser and in-memory ScheduledTasks triggers'
  powershell = $PSVersionTable.PSVersion.ToString()
  os = [System.Environment]::OSVersion.Version.ToString()
  cases = $results
}
$json = $fixture | ConvertTo-Json -Depth 6 -Compress
[System.IO.File]::WriteAllText($OutPath, $json + "`n", (New-Object System.Text.UTF8Encoding $false))
Write-Output "Checked $($results.Count) scripts with PowerShell $($PSVersionTable.PSVersion) -> $OutPath"
