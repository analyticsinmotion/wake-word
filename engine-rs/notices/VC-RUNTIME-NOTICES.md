# Microsoft Visual C++ runtime libraries

This directory contains the following Microsoft Visual C++ runtime libraries
for x64, version 14.44.35211.0:

- `msvcp140.dll`
- `msvcp140_1.dll`
- `vcruntime140.dll`
- `vcruntime140_1.dll`

They are the files from the Microsoft Visual C++ Redistributable, unmodified,
and each carries Microsoft's digital signature. `onnxruntime.dll` in this
directory imports them, and Windows loads them from here, so the Visual C++
Redistributable does not have to be installed.

Copyright (c) Microsoft Corporation. All rights reserved.

These libraries are not covered by the license of the Wake Word extension.
They are Microsoft software, distributed under the Microsoft Software License
Terms for Microsoft Visual Studio:
<https://visualstudio.microsoft.com/license-terms/>. The list of files that
may be distributed is at
<https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution>.
