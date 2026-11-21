// Payesh web32 shell — V8 glue for window.payeshHost (row 169, D-50).
// Every function is synchronous; binary data crosses as "latin1" strings (one UTF-16 code
// unit per byte); failures throw a JS Error whose message is "<code>|<message>".
#include "host_v8.h"

#include <string>
#include <vector>

#include "host_ops.h"
#include "include/cef_command_line.h"
#include "include/cef_parser.h"
#include "include/cef_process_message.h"
#include "include/cef_values.h"
#include "util.h"

namespace payesh {

namespace {

const char* const kFunctions[] = {
    "info",  "stat",   "read",   "write",   "list",  "mkdir",  "remove",   "rename",
    "copy",  "setMtime", "fopen", "fread",  "fwrite", "fsize", "ftrunc",   "fsync",
    "fclose", "dpapi", "run",    "spawn",   "kill",  "openUrl", "resolve", "trustPem",
    "exit",  "log",
};

std::wstring Str(const CefV8ValueList& a, size_t i) {
  if (i >= a.size() || !a[i]->IsString()) return std::wstring();
  return a[i]->GetStringValue().ToWString();
}

int64_t Num(const CefV8ValueList& a, size_t i, int64_t def = 0) {
  if (i >= a.size()) return def;
  const auto& v = a[i];
  if (v->IsInt()) return v->GetIntValue();
  if (v->IsUInt()) return v->GetUIntValue();
  if (v->IsDouble()) return static_cast<int64_t>(v->GetDoubleValue());
  return def;
}

bool Flag(const CefV8ValueList& a, size_t i) {
  return i < a.size() && a[i]->IsBool() && a[i]->GetBoolValue();
}

bool Latin1Arg(const CefV8ValueList& a, size_t i, Bytes& out, HostErr& e) {
  out.clear();
  if (i >= a.size() || !a[i]->IsString()) return true;
  const std::wstring w = a[i]->GetStringValue().ToWString();
  out.resize(w.size());
  for (size_t k = 0; k < w.size(); ++k) {
    if (w[k] > 0xff) {
      e.Set(ERROR_INVALID_PARAMETER, L"binary data must be latin1");
      return false;
    }
    out[k] = static_cast<char>(w[k]);
  }
  return true;
}

CefRefPtr<CefV8Value> Latin1Value(const Bytes& b) {
  std::wstring w(b.size(), L'\0');
  for (size_t k = 0; k < b.size(); ++k) w[k] = static_cast<unsigned char>(b[k]);
  return CefV8Value::CreateString(w);
}

std::vector<std::wstring> StringList(const std::wstring& json) {
  std::vector<std::wstring> out;
  CefRefPtr<CefValue> v = CefParseJSON(json, JSON_PARSER_RFC);
  if (!v || v->GetType() != VTYPE_LIST) return out;
  CefRefPtr<CefListValue> l = v->GetList();
  for (size_t i = 0; i < l->GetSize(); ++i) out.push_back(l->GetString(i).ToWString());
  return out;
}

CefRefPtr<CefV8Value> Json(CefRefPtr<CefValue> v) {
  return CefV8Value::CreateString(CefWriteJSON(v, JSON_WRITER_DEFAULT));
}

CefRefPtr<CefValue> Wrap(CefRefPtr<CefDictionaryValue> d) {
  CefRefPtr<CefValue> v = CefValue::Create();
  v->SetDictionary(d);
  return v;
}

CefRefPtr<CefValue> Wrap(CefRefPtr<CefListValue> l) {
  CefRefPtr<CefValue> v = CefValue::Create();
  v->SetList(l);
  return v;
}

std::wstring InfoJson() {
  CefRefPtr<CefCommandLine> cl = CefCommandLine::GetGlobalCommandLine();
  CefRefPtr<CefDictionaryValue> d = CefDictionaryValue::Create();
  d->SetString("os", "windows");
  d->SetString("osVersion", OsVersionText());
  CefRefPtr<CefDictionaryValue> env = CefDictionaryValue::Create();
  for (const auto& kv : Environment()) env->SetString(kv.first, kv.second);
  d->SetDictionary("env", env);
  d->SetString("exe", ExePath());
  int64_t pid = 0;
  if (cl && cl->HasSwitch(kSwitchBrowserPid)) {
    pid = _wtoi64(cl->GetSwitchValue(kSwitchBrowserPid).ToWString().c_str());
  }
  d->SetDouble("pid", static_cast<double>(pid ? pid : GetCurrentProcessId()));
  d->SetInt("cpus", CpuCount());
  d->SetString("hostname", HostName());
  d->SetString("locale", LocaleName());
  d->SetString("temp", TempDir());
  wchar_t home[MAX_PATH] = {};
  GetEnvironmentVariableW(L"USERPROFILE", home, MAX_PATH);
  d->SetString("home", home);
  d->SetString("app", Identity().id);
  CefRefPtr<CefListValue> args = CefListValue::Create();
  if (cl && cl->HasSwitch(kSwitchArgs)) {
    std::string json = FromHex(cl->GetSwitchValue(kSwitchArgs).ToString());
    size_t i = 0;
    for (const auto& a : StringList(Utf8ToWide(json))) args->SetString(i++, a);
  }
  d->SetList("args", args);
  d->SetString("shell", "payesh-web32/1 cef-109");
  return CefWriteJSON(Wrap(d), JSON_WRITER_DEFAULT).ToWString();
}

void SendToBrowser(const char* name, const std::wstring& text, int64_t number) {
  CefRefPtr<CefV8Context> ctx = CefV8Context::GetCurrentContext();
  if (!ctx) return;
  CefRefPtr<CefFrame> frame = ctx->GetFrame();
  if (!frame) return;
  CefRefPtr<CefProcessMessage> msg = CefProcessMessage::Create(name);
  msg->GetArgumentList()->SetString(0, text);
  msg->GetArgumentList()->SetInt(1, static_cast<int>(number));
  frame->SendProcessMessage(PID_BROWSER, msg);
}

class HostHandler : public CefV8Handler {
 public:
  HostHandler() = default;

  bool Execute(const CefString& name, CefRefPtr<CefV8Value> object,
               const CefV8ValueList& a, CefRefPtr<CefV8Value>& retval,
               CefString& exception) override {
    HostErr e;
    retval = CefV8Value::CreateUndefined();
    const std::string fn = name.ToString();
    if (fn == "info") {
      retval = CefV8Value::CreateString(InfoJson());
    } else if (fn == "stat") {
      HostStat s = StatPath(Str(a, 0));
      CefRefPtr<CefDictionaryValue> d = CefDictionaryValue::Create();
      d->SetString("t", std::wstring(1, s.type));
      d->SetDouble("s", static_cast<double>(s.size));
      d->SetDouble("m", static_cast<double>(s.modifiedMs));
      retval = Json(Wrap(d));
    } else if (fn == "read") {
      Bytes b = ReadPath(Str(a, 0), Num(a, 1, -1), Num(a, 2, -1), e);
      if (!e.failed()) retval = Latin1Value(b);
    } else if (fn == "write") {
      Bytes data;
      if (Latin1Arg(a, 1, data, e)) WritePath(Str(a, 0), data, Flag(a, 2), e);
    } else if (fn == "list") {
      auto entries = ListDir(Str(a, 0), e);
      if (!e.failed()) {
        CefRefPtr<CefListValue> l = CefListValue::Create();
        size_t i = 0;
        for (const auto& en : entries) {
          CefRefPtr<CefListValue> pair = CefListValue::Create();
          pair->SetString(0, en.first);
          pair->SetString(1, std::wstring(1, en.second));
          l->SetList(i++, pair);
        }
        retval = Json(Wrap(l));
      }
    } else if (fn == "mkdir") {
      MakeDirs(Str(a, 0), e);
    } else if (fn == "remove") {
      RemovePath(Str(a, 0), Flag(a, 1), e);
    } else if (fn == "rename") {
      RenamePath(Str(a, 0), Str(a, 1), e);
    } else if (fn == "copy") {
      CopyPath(Str(a, 0), Str(a, 1), e);
    } else if (fn == "setMtime") {
      SetModified(Str(a, 0), Num(a, 1), e);
    } else if (fn == "fopen") {
      int h = FileOpen(Str(a, 0), Str(a, 1), e);
      if (!e.failed()) retval = CefV8Value::CreateInt(h);
    } else if (fn == "fread") {
      Bytes b = FileRead(static_cast<int>(Num(a, 0)), Num(a, 1), Num(a, 2), e);
      if (!e.failed()) retval = Latin1Value(b);
    } else if (fn == "fwrite") {
      Bytes data;
      if (Latin1Arg(a, 2, data, e)) FileWrite(static_cast<int>(Num(a, 0)), Num(a, 1), data, e);
    } else if (fn == "fsize") {
      int64_t s = FileSize(static_cast<int>(Num(a, 0)), e);
      if (!e.failed()) retval = CefV8Value::CreateDouble(static_cast<double>(s));
    } else if (fn == "ftrunc") {
      FileTruncate(static_cast<int>(Num(a, 0)), Num(a, 1), e);
    } else if (fn == "fsync") {
      FileSync(static_cast<int>(Num(a, 0)), e);
    } else if (fn == "fclose") {
      FileClose(static_cast<int>(Num(a, 0)), e);
    } else if (fn == "dpapi") {
      Bytes data, entropy;
      if (Latin1Arg(a, 0, data, e) && Latin1Arg(a, 1, entropy, e)) {
        Bytes r = Dpapi(data, entropy, Flag(a, 2), e);
        if (!e.failed()) retval = Latin1Value(r);
      }
    } else if (fn == "run") {
      int64_t t = Num(a, 3, 60000);
      HostRunResult r = RunProcess(Str(a, 0), StringList(Str(a, 1)), Str(a, 2),
                                   t <= 0 ? INFINITE : static_cast<DWORD>(t), e);
      if (!e.failed()) {
        CefRefPtr<CefDictionaryValue> d = CefDictionaryValue::Create();
        d->SetDouble("pid", r.pid);
        d->SetDouble("code", static_cast<double>(r.code));
        d->SetString("out", r.out);
        d->SetString("err", r.err);
        retval = Json(Wrap(d));
      }
    } else if (fn == "spawn") {
      DWORD pid = SpawnProcess(Str(a, 0), StringList(Str(a, 1)), Str(a, 2), e);
      if (!e.failed()) retval = CefV8Value::CreateDouble(pid);
    } else if (fn == "kill") {
      retval = CefV8Value::CreateBool(KillProcess(static_cast<DWORD>(Num(a, 0))));
    } else if (fn == "openUrl") {
      SendToBrowser(kMsgOpenUrl, Str(a, 0), 0);
    } else if (fn == "resolve") {
      auto ips = Resolve(Str(a, 0), e);
      if (!e.failed()) {
        CefRefPtr<CefListValue> l = CefListValue::Create();
        size_t i = 0;
        for (const auto& ip : ips) l->SetString(i++, ip);
        retval = Json(Wrap(l));
      }
    } else if (fn == "trustPem") {
      // CEF 109 verifies TLS with Chrome's own root store (independent of the old Windows 7
      // roots), so extra PEM roots are not needed here.
    } else if (fn == "exit") {
      SendToBrowser(kMsgExit, L"", Num(a, 0));
    } else if (fn == "log") {
      ShellLog(L"[app] " + Str(a, 0));
    } else {
      return false;
    }
    if (e.failed()) {
      exception = std::to_wstring(e.code) + L"|" + e.msg;
      retval = nullptr;
    }
    return true;
  }

 private:
  IMPLEMENT_REFCOUNTING(HostHandler);
};

}  // namespace

void InstallHost(CefRefPtr<CefV8Context> context) {
  CefRefPtr<CefV8Value> global = context->GetGlobal();
  CefRefPtr<CefV8Handler> handler = new HostHandler();
  CefRefPtr<CefV8Value> host = CefV8Value::CreateObject(nullptr, nullptr);
  for (const char* fn : kFunctions) {
    host->SetValue(fn, CefV8Value::CreateFunction(fn, handler), V8_PROPERTY_ATTRIBUTE_READONLY);
  }
  global->SetValue("payeshHost", host,
                   static_cast<cef_v8_propertyattribute_t>(V8_PROPERTY_ATTRIBUTE_READONLY |
                                                           V8_PROPERTY_ATTRIBUTE_DONTDELETE));
}

}  // namespace payesh
