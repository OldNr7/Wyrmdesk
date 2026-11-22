; Inno Setup script for the Windows installer of the native app (Inno Setup 6).
; Built by ..\build-windows.bat, which passes the version from VERSION:
;   ISCC /DAppVersion=0.1.0 windows\wyrmdesk.iss
; Installs per user (no admin rights) to %LOCALAPPDATA%\Programs\Wyrmdesk. The data stay apart in
; %LOCALAPPDATA%\Wyrmdesk and survive an uninstall and every update.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
; Never change the AppId: Windows recognises updates and the uninstall by it.
AppId={{6B0E7C1D-4F7A-4C55-9A0E-57A1D3C9B2E4}
AppName=Wyrmdesk
AppVersion={#AppVersion}
AppVerName=Wyrmdesk {#AppVersion}
AppPublisher=Wyrmdesk
AppPublisherURL=https://wyrmdesk.ch
AppSupportURL=https://wyrmdesk.ch
VersionInfoVersion={#AppVersion}
DefaultDirName={autopf}\Wyrmdesk
DefaultGroupName=Wyrmdesk
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\dist\packages
OutputBaseFilename=Wyrmdesk-Setup-{#AppVersion}
SetupIconFile=..\wyrmdesk.ico
UninstallDisplayIcon={app}\wyrmdesk.exe
UninstallDisplayName=Wyrmdesk
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; A running Wyrmdesk holds its files: ask to close it before an update.
CloseApplications=yes

[Languages]
Name: "de"; MessagesFile: "compiler:Languages\German.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\dist\wyrmdesk\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

; An update replaces the program folder completely, so no file of an older version stays behind.
[InstallDelete]
Type: filesandordirs; Name: "{app}\_internal"

[Icons]
Name: "{autoprograms}\Wyrmdesk"; Filename: "{app}\wyrmdesk.exe"
Name: "{autodesktop}\Wyrmdesk"; Filename: "{app}\wyrmdesk.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\wyrmdesk.exe"; Description: "{cm:LaunchProgram,Wyrmdesk}"; Flags: nowait postinstall skipifsilent
