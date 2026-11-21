// Payesh web32 shell — CefApp for the browser and the renderer processes (row 169, D-50).
#pragma once

#include "include/cef_app.h"

namespace payesh {

class ShellApp : public CefApp, public CefBrowserProcessHandler, public CefRenderProcessHandler {
 public:
  ShellApp() = default;

  // CefApp
  void OnBeforeCommandLineProcessing(const CefString& process_type,
                                     CefRefPtr<CefCommandLine> command_line) override;
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override { return this; }
  CefRefPtr<CefRenderProcessHandler> GetRenderProcessHandler() override { return this; }

  // CefBrowserProcessHandler
  void OnContextInitialized() override;
  void OnBeforeChildProcessLaunch(CefRefPtr<CefCommandLine> command_line) override;

  // CefRenderProcessHandler
  void OnContextCreated(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                        CefRefPtr<CefV8Context> context) override;

 private:
  IMPLEMENT_REFCOUNTING(ShellApp);
};

// Implemented in main.cc: creates the top-level window and the browser in it.
void CreateMainWindow();

}  // namespace payesh
