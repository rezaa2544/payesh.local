# Payesh web32 shell (row 169, D-50) — the 32-bit Windows edition's program.
#   cmake -S tools/web32/shell -B build32 -A Win32 -DCEF_ROOT=<cef_binary_109…_windows32_minimal>
#   cmake --build build32 --config Release
# Produces build32/Release/payesh_app.exe and payesh_owner.exe (same source, PAYESH_OWNER selects identity).
cmake_minimum_required(VERSION 3.19)
set(CMAKE_CONFIGURATION_TYPES Release)
project(payesh_web32 LANGUAGES C CXX)

if(NOT DEFINED CEF_ROOT)
  message(FATAL_ERROR "CEF_ROOT must point at the CEF 109 windows32 binary distribution")
endif()
# a Windows path (D:\a\_temp\…) would be re-parsed by cef_macros.cmake as escapes
file(TO_CMAKE_PATH "${CEF_ROOT}" CEF_ROOT)
set(CMAKE_MODULE_PATH ${CMAKE_MODULE_PATH} "${CEF_ROOT}/cmake")
set(USE_SANDBOX OFF CACHE BOOL "The renderer does file I/O for window.payeshHost" FORCE)
find_package(CEF REQUIRED)
if(NOT PROJECT_ARCH STREQUAL "x86")
  message(FATAL_ERROR "the web32 shell is a 32-bit build (-A Win32), got ${PROJECT_ARCH}")
endif()
add_subdirectory(${CEF_LIBCEF_DLL_WRAPPER_PATH} libcef_dll_wrapper)
ADD_LOGICAL_TARGET("libcef_lib" "${CEF_LIB_DEBUG}" "${CEF_LIB_RELEASE}")
SET_CEF_TARGET_OUT_DIR()

set(SHELL_SRCS
  src/app.cc src/app.h
  src/client.cc src/client.h
  src/host_ops.cc src/host_ops.h
  src/host_v8.cc src/host_v8.h
  src/main.cc
  src/scheme.cc src/scheme.h
  src/util.cc src/util.h
)

foreach(APP app owner)
  set(T payesh_${APP})
  add_executable(${T} WIN32 ${SHELL_SRCS} res/${APP}.rc)
  SET_EXECUTABLE_TARGET_PROPERTIES(${T})
  add_dependencies(${T} libcef_dll_wrapper)
  target_link_libraries(${T} libcef_lib libcef_dll_wrapper ${CEF_STANDARD_LIBS}
    crypt32.lib shell32.lib ole32.lib advapi32.lib)
  # Persian literals in the source; warnings stay visible but do not fail the build.
  target_compile_options(${T} PRIVATE /utf-8 /WX-)
  target_include_directories(${T} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
  if(APP STREQUAL "owner")
    target_compile_definitions(${T} PRIVATE PAYESH_OWNER=1)
  endif()
  ADD_WINDOWS_MANIFEST("${CMAKE_CURRENT_SOURCE_DIR}/res" "${T}" "exe")
endforeach()
