FROM mcr.microsoft.com/dotnet/sdk:10.0
RUN apt-get update && apt-get install -y --no-install-recommends nodejs zip && rm -rf /var/lib/apt/lists/*
RUN dotnet tool install -g ilspycmd
ENV PATH="$PATH:/root/.dotnet/tools" HOST=0.0.0.0 PORT=8080 UNPACK_RUN=0 DOTNET_CLI_TELEMETRY_OPTOUT=1
WORKDIR /app
COPY server.js ./
COPY public ./public
COPY recorded ./recorded
COPY openra_app.tgz ./
RUN tar xzf openra_app.tgz && rm openra_app.tgz && cd openra_app && mkdir orig && mv orig_bin orig/bin && for f in reb/*; do n=$(basename "$f"); [ "$n" = bin ] || ln -s "/app/openra_app/reb/$n" "orig/$n"; done
COPY demo/snake/orig_build ./demo/snake/orig_build
COPY demo/snake/Snake/Program.cs demo/snake/Snake/Snake.csproj ./demo/snake/Snake/
EXPOSE 8080
CMD ["node","server.js"]
