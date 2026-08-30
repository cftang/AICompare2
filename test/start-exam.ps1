$node = "C:\Program Files\nodejs\node.exe"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$args_ = "`"$dir\exam-runner.mjs`" `"C:\Users\thinkpad\Downloads\infer\exam2.txt`" `"c:\tmp\exam2answer.md`" `"C:\tmp\exam2-progress.log`""
$proc = Start-Process -FilePath $node `
  -ArgumentList $args_ `
  -WorkingDirectory $dir `
  -RedirectStandardOutput "C:\tmp\exam2-runner.out" `
  -RedirectStandardError "C:\tmp\exam2-runner.err" `
  -WindowStyle Hidden -PassThru
$proc.Id | Out-File -Encoding ascii C:\tmp\exam2-runner.pid
Write-Output ("pid=" + $proc.Id)
