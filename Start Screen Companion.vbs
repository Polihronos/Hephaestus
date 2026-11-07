Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
shell.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = ""
shell.Run Chr(34) & root & "\node_modules\electron\dist\electron.exe" & Chr(34) & " " & Chr(34) & root & Chr(34), 0, False
