$node = "C:\Program Files\nodejs\node.exe"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$args_ = "`"$dir\exam-runner.mjs`" `"C:\Users\thinkpad\Downloads\infer\exam0.txt`" `"c:\tmp\exam0answer.md`" `"C:\tmp\exam0-progress.log`""
$proc = Start-Process -FilePath $node `
  -ArgumentList $args_ `
  -WorkingDirectory $dir `
  -RedirectStandardOutput "C:\tmp\exam0-runner.out" `
  -RedirectStandardError "C:\tmp\exam0-runner.err" `
  -WindowStyle Hidden -PassThru
$proc.Id | Out-File -Encoding ascii C:\tmp\exam0-runner.pid
Write-Output ("pid=" + $proc.Id)
