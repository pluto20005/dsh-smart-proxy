' Watchdog: ask Task Scheduler to start the relay task.
' Runs every minute; if the relay is already running, Task Scheduler's
' IgnoreNew policy makes this a no-op.
Set sh = CreateObject("WScript.Shell")
sh.Run "schtasks /run /tn DSH-SmartProxy", 0, False
