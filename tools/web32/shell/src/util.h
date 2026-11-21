// Payesh web32 shell — small Win32 helpers shared by the browser and renderer sides.
// Row 169 (D-50). Keep this file free of CEF types except CefString/CefValue helpers.
#pragma once

#include <windows.h>

#include <cstdint>
#include <string>
#include <vector>

namespace payesh {

// Identity of this build (payesh_app.exe or payesh_owner.exe; same source).
struct AppIdentity {
  const wchar_t* id;          // "app" | "owner"
  const wchar_t* title;       // initial window title
  const wchar_t* dataFolder;  // %LOCALAPPDATA%\<dataFolder> (CEF profile, shell log)
  const wchar_t* windowClass;
  const wchar_t* mutexName;
};
const AppIdentity& Identity();

// The origin the app is served from (never reaches the network: scheme handler).
constexpr const char kAppHost[] = "payesh.localhost";
constexpr const char kAppOrigin[] = "http://payesh.localhost";
constexpr const wchar_t kAppUrl[] = L"http://payesh.localhost/index.html";

std::wstring Utf8ToWide(const std::string& s);
std::string WideToUtf8(const std::wstring& s);

// Directory of the running .exe, without a trailing backslash.
std::wstring ExeDir();
std::wstring ExePath();

// %LOCALAPPDATA%\<dataFolder> (created).
std::wstring DataDir();

// Text of a Windows error code (no trailing newline).
std::wstring ErrorText(DWORD code);

// Appends a line to <DataDir>\web32-shell.log (kept below ~1 MB).
void ShellLog(const std::wstring& line);

// Windows command-line quoting of one argument (MSVCRT rules, like dart:io).
std::wstring QuoteArg(const std::wstring& arg);

// Decodes process output: UTF-8 when valid, else the OEM code page (console tools).
std::wstring DecodeOutput(const std::string& bytes);

// Hex of UTF-8 (to carry text through Chromium switches) and back.
std::string HexOf(const std::string& s);
std::string FromHex(const std::string& s);

}  // namespace payesh
