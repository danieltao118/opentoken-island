!macro NSIS_HOOK_POSTINSTALL
  Delete "$DESKTOP\OpenToken Island.lnk"
  Delete "$SMPROGRAMS\OpenToken Island.lnk"
  CreateShortCut "$DESKTOP\OpenToken 小岛.lnk" "$INSTDIR\opentoken-island.exe"
  CreateShortCut "$SMPROGRAMS\OpenToken 小岛.lnk" "$INSTDIR\opentoken-island.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OpenTokenIsland"
    Delete "$DESKTOP\OpenToken 小岛.lnk"
    Delete "$SMPROGRAMS\OpenToken 小岛.lnk"
    ; 0.1.5 起代理 detached 常驻：卸载时先关 GUI，再优雅通知 4174 代理退出
    ; （/api/shutdown 仅本机可用；不按镜像名杀 node.exe，避免误杀用户其他 Node 进程）。
    nsExec::Exec 'taskkill /F /IM "opentoken-island.exe"'
    nsExec::Exec 'curl -s -X POST http://127.0.0.1:4174/api/shutdown'
  ${EndIf}
!macroend
