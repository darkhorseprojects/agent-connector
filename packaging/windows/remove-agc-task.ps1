param(
    [string]$TaskName = "Agent Connector"
)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
