# Unpack: get the source code back

Drop in a compiled .NET program and get the project back as readable, buildable C# source, plus a report on how close the rebuilt version is to the original.

Live demo: https://unpack-production-ca8e.up.railway.app

Built at HackOHI/O 2026 (Open Track).

## Why

Source code gets lost all the time. A laptop dies, a developer leaves, and all that is left of an old project is the finished program. Unpack gets the project back so you can fix it, change it and build on it. You can also take an open source program, recover its source and build something new on top of it.

## How it works

1. **Decompile** the compiled files to C# with ILSpy.
2. **Auto-repair** the mistakes decompilers usually make: ambiguous null overloads, numeric literals, scoped spans, missing local functions, and constructor attributes that the decompiler drops (read straight from the compiled IL, since the compiler cannot see them).
3. **Rebuild** the project with `dotnet build` and run its tests.
4. **Run both** the original and the rebuilt copy side by side and compare what they actually do.
5. **Score and package** the result as a downloadable project.

## What we tested it on

OpenRA, the open source engine behind Red Alert. From 7 compiled assemblies Unpack recovered about 2,800 C# files and over 200,000 lines. The project builds and the engine's 130 tests pass. We replayed one Red Alert match on the original and on the rebuilt engine and the two stayed in step: same units, positions and game clock. Because the source is back, we could also edit two lines and rebuild a modded game.

## Layout

- `server.js` web server and API (Node.js, no dependencies)
- `public/` the site
- `tools/unpack_multi.py` the multi-assembly pipeline: decompile, repair, build, check, score
- `recorded/openra/` a recorded run of the real pipeline on OpenRA, used by the demo
- `Dockerfile` the Railway deployment image (also needs an `openra_app.tgz` of the original and rebuilt OpenRA binaries, which is not included here)

## Limits

Works on .NET programs for now. Native C and C++ programs come back as readable strings only. Unpack is meant for software you have the right to use, such as your own lost project or open source. Please do not use it on someone else's copyrighted work.

## Credits

OpenRA is GPL-3.0 licensed (https://www.openra.net). The rebuilt OpenRA project in `recorded/` is derived from it and keeps that license. ILSpy is MIT licensed.

Unpack's own code is MIT licensed.
