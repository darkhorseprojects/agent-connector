param(
    [Parameter(Mandatory = $true)]
    [string]$Executable,

    [Parameter(Mandatory = $true)]
    [string]$AgentDirectory,

    [string]$TaskName = "Agent Connector"
)

$Executable = (Resolve-Path -LiteralPath $Executable).Path
$AgentDirectory = (Resolve-Path -LiteralPath $AgentDirectory).Path
$Action = New-ScheduledTaskAction -Execute $Executable -Argument ('run "{0}"' -f $AgentDirectory.Replace('"', '""'))
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -RestartCount 10 -RestartInterval (New-TimeSpan -Seconds 5)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Description "Run Agent Connector at logon"
