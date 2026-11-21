// Payesh web32 shell — `window.payeshHost` in the app's main frame (row 169, D-50).
#pragma once

#include "include/cef_v8.h"

namespace payesh {

// Process messages from the renderer to the browser process.
constexpr const char kMsgExit[] = "payesh.exit";
constexpr const char kMsgOpenUrl[] = "payesh.openUrl";

// Switches the browser process adds to every child process.
constexpr const char kSwitchBrowserPid[] = "payesh-browser-pid";
constexpr const char kSwitchArgs[] = "payesh-args";

// Installs window.payeshHost into |context| (only ever called for the app's own origin).
void InstallHost(CefRefPtr<CefV8Context> context);

}  // namespace payesh
