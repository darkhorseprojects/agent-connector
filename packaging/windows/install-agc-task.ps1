param(
    [Parameter(Mandatory = $true)]
    [string]$Executable,

    [Parameter(Mandatory = $true)]
    [string]$ConfigDirectory,

    [string]$TaskName = "Agent Connector"
)

$Executable = (Resolve-Path -LiteralPath $Executable).Path
$ConfigDirectory = (Resolve-Path -LiteralPath $ConfigDirectory).Path
$Action = New-ScheduledTaskAction -Execute $Executable -Argument ('run "{0}"' -f $ConfigDirectory.Replace('"', '""'))
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -RestartCount 10 -RestartInterval (New-TimeSpan -Seconds 5)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Description "Run Agent Connector at logon"
