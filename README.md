# Ms-Robot

在 **浏览器** 里面远程批量管理连接到ADB设备上的安卓手机，线控很稳定，远程很方便。

---

## 界面预览

多设备控制台与文件管理（上传、批量推送 / 安装 APK 等）：

![多设备控制台与文件管理](./docs/assets/1.png)

单路投全屏与控制示例：

![单设备投屏与控制](./docs/assets/2.png)

---

## 为什么选择 Ms-Robot


| 特点              | 说明                                                                          |
| --------------- | --------------------------------------------------------------------------- |
| **浏览器远控界面**     | 在 **电脑浏览器** 里完成投屏、触控、文件，进阶还有命令行（Shell）。                                     |
| **手机 0 安装 App** | 系统干净安全，不占用空间。                                                               |
| **多平台适配**       | 支持Windows，Linux，Mac运行,单文件部署，Docker命令部署，超低性能消耗。                                         |
| **多会话协同**       | 可同时查看，控制，同步广播多台设备， 多用户可同时操控。                                                |
| **多 ADB 端点**    | 完全基于Adb协议，支持本机 `adb`、远程 `adb` 主机、可选 SOCKS5 代理与断线重试，方便对接机房或家里的 `adb server`。 |


---

## 使用前准备

1. **Android 设备**：开启「开发者选项」与 **USB 调试**（或已 `adb tcpip` 的网络调试）。
2. **本机安装 Android SDK Platform-Tools**（内含 `adb`），并确保 `adb` 在 `PATH` 中。
3. **启动 adb server（本机默认场景）**
  - 连接 USB 后执行：`adb devices`（会自动拉起本机 adb server）。  
  - 或显式：`adb start-server`。
4. **连接远程 adb server（可选）**
  - 若你在另一台机器上跑了 `adb -a nodaemon server` 或默认的 `5037` 服务，可在本机用 `-endpoint adb=那台机器IP` 连接（见下文「命令行参数」）。  
  - 常见网络调试：`adb connect 手机IP:5555`，手机上仍由 **本机或远程** 的 `adb` 暴露设备列表给 Ms-Robot。

---

## 通过Go安装直接运行（通用，需要装adb）

```bash
go install github.com/ms-robots/ms-robot@latest # 安装

adb server # 启动adb
ms-robot
```

## Linux Docker 环境下一键构建运行（适用低性能设备，比如树莓派等小主机）

需安装Docker， 需root权限，或者docker组账户，不用另外装adb。复制运行

### 构建+运行

```shell
# 构建
export DOCKERFILE='
ARG BUILD_IMAGE="golang:alpine"
ARG RUNTIME_IMAGE="backplane/adb:latest"

FROM ${BUILD_IMAGE} AS builder
ARG GOPROXY="https://goproxy.cn,https://goproxy.io,direct"
ARG GO_INSTALL_TARGET="github.com/ms-robots/ms-robot@latest"
RUN export GOPROXY=${GOPROXY} GO111MODULE=on CGO_ENABLED=0 GOOS=linux; \
  go install ${GO_INSTALL_TARGET};

FROM ${RUNTIME_IMAGE} AS runner
COPY --from=builder /go/bin/* /usr/local/bin/
'

printf "$DOCKERFILE" | docker build -f - . -t ms-robot:latest

# 运行
mkdir ms-robot; cd ms-robot
docker run -d --name ms-robot --restart unless-stopped \
   --privileged --net host \
   -v /dev/bus/usb:/dev/bus/usb \
   -v $PWD/.android:/root/.android \
   -v $PWD:/app -w /app --entrypoint bash \
   ms-robot:latest -c "adb server; ms-robot"
```

### 启停控制

```shell
docker stop ms-robot # 停止
docker start ms-robot # 启动
docker rm -f ms-robot # 删除容器。 可以执行上面的docker run重新创建容器
```

### 启动后

默认浏览器访问：[http://127.0.0.1:20605](http://127.0.0.1:20605)（可用 `-http-listen` 修改）。

### 环境变量


| 变量          | 说明                                                  |
| ----------- | --------------------------------------------------- |
| `LOG_LEVEL` | 日志级别：`debug` / `info` / `warn` / `error`，默认 `info`。 |


---

## 命令行参数


| 参数                   | 默认值            | 说明                                                                                                          |
| -------------------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| `-http-listen`       | `tcp://:20605` | HTTP 监听地址。支持 `tcp://主机:端口`、仅端口 `tcp://:20605`，以及 **Unix 域套接字** `unix:///path/to.sock` 等（由 `listenutil` 解析）。 |
| `-turn-port`         | `3478`         | **内置 TURN/STUN** 监听端口；若占用请改端口。ICE 地址会结合请求的 `Host` 动态下发给浏览器。                                                 |
| `-debug`             | `false`        | 调试模式（例如前端可通过 `?debug=1` 等开关加载调试能力）。                                                                         |
| `-without-endpoint`  | `false`        | 为 `true` 时**不**自动添加默认端点；且若未传任何 `-endpoint`，则端点列表为空。                                                         |
| `-endpoints-mutable` | `false`        | 为 `true` 时允许通过界面或 API **增删改** ADB 端点；为 `false` 时相关能力关闭。                                                     |
| `-endpoint`          | （可多次）          | 增加一个 ADB 端点；**可重复指定**。不传且未设 `-without-endpoint` 时，默认等价于 `adb=localhost,name=本机`（`retry` 默认 `-1` 表示持续重试）。    |


### `-endpoint` 写法示例

```text
adb=192.168.1.100
adb=192.168.1.100,name=机房-A,retry=-1
adb=192.168.1.100:5037,name=本机,proxy=socks5://user:pass@proxy:1080,retry=-1
retry=-1,name=本机,adb=localhost
```

字段说明（键值对，逗号分隔，顺序不限）：

- `**adb**`：`adb` 服务地址（主机或 `host:5037`）。  
- `**name**`：在 Web 上显示的端点备注。  
- `**proxy**`：可选，SOCKS5 代理 URL。adb连接能经过sock5，适用于单端口转发场景  
- `**retry**`：断线重试策略；`0` 表示不重试并可触发移除逻辑；`-1` 表示一直重试。

---

## 下载源码手动构建运行

### 支持多平台多架构

- **产物路径**：`dist/ms-robot-<GOOS>-<GOARCH>.exe`（`<GOOS>`、`<GOARCH>` 取自执行 `make` 时的 `go env`；当前 Makefile 对**所有**目标平台都使用 `.exe` 后缀，若需无后缀可执行文件可自行改名复制）。  
- **多平台 / 多架构**：交叉编译时先设定 `GOOS`、`GOARCH`，再执行 **同一套** `make build`；每种组合各打一次，就会在 `dist/` 里得到对应文件名。本机支持哪些组合可用 `go tool dist list` 查看。

```bash
# Linux x86_64
GOOS=linux GOARCH=amd64 make

# Windows x86_64
GOOS=windows GOARCH=amd64 make

# macOS Apple Silicon
GOOS=darwin GOARCH=arm64 make

# macOS Intel
GOOS=darwin GOARCH=amd64 make
```

PowerShell 示例（与 Bash 等价）：

```powershell
$env:GOOS = "linux"; $env:GOARCH = "amd64"; make
```

### Docker 运行adb+ms-robot（适用低性能设备，比如树莓派等小主机）

首先自行构建好对应平台对应架构的`ms-robot.exe`, 上传到设备里

```shell
ls -lah ms-robot.exe # 文件已经上传好了

docker run -d --name ms-robot --restart always \
   --privileged --net host \
   -v /dev/bus/usb:/dev/bus/usb \
   -v $PWD/.android:/root/.android \
   -v $PWD:/app -w /app --entrypoint sh \
   backplane/adb -c "adb server; ./ms-robot.exe"
```

直接运行，adb签名文件在`$PWD/.android`

### Windows,Mac

先启动一下adb

```shell
adb server
```

然后启动ms-robot

```shell
./ms-robot.exe
```

---

## 支持功能清单

> 下列为本仓库**当前实现**所提供的能力。

- **Web 控制台**：设备列表、详情、实时画面（WebRTC）、触摸/按键控制、**控制数据广播**（多前端会话）。  
- **交互式 ADB Shell**  
- **文件**：上传、列表、按条件/按 ID 清理；多设备 **ADB Push**、**APK 批量安装**（依赖服务端本地文件与 ADB）。  
- **端点**：查询与（在 `-endpoints-mutable` 开启时）增删改。  
- **设备音频**（可选）：在已有投屏会话前提下，通过 API 开关设备侧音频采集与转发。（仅支持Android 11+)

---

## 鸣谢

集成 **[Genymobile / scrcpy](https://github.com/Genymobile/scrcpy)** 实现屏幕数据采集。

---

**提示**：公网暴露控制台前，请务必加 **HTTPS、鉴权、防火墙与速率限制**；默认发行不包含账号体系，需由部署者自行加固。

## 免责声明

1、本工具（ms-robot）仅用于个人合法学习、技术交流与研究测试，严禁用于任何商业用途、非法活动或未经授权的网络行为。

2、使用者需自行承担使用本工具的全部风险与法律责任，开发者不对工具的使用效果、安全性及任何损失承担责任。

3、使用本工具即视为同意本免责声明的全部条款。
