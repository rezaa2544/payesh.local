// Payesh web32 shell — serves the Flutter web build from <exe dir>\web (row 169, D-50).
#pragma once

namespace payesh {

// http://payesh.localhost/<path> → <exe dir>\web\<path>; never touches the network.
void RegisterAppScheme();

}  // namespace payesh
