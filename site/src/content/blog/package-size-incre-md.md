---
title: Compose Multiplatform 包体积暴涨原因排查记录
date: '2026-01-29T16:48:52+08:00'
updated: '2026-01-30T04:29:26.782Z'
legacyPath: /2026/01/29/package-size-incre-md/
categories:
  - Compose Multiplatform
tags:
  - Compose Multiplatform
  - Gradle
---
## 案例一

2025年12月18日，发现v1.0.3版本桌面端安装包体积爆炸增大，从原本的150MB左右暴涨到1GB，如下图所示。
![image.png](/legacy-assets/package-size-incre-md/image.png)

由于三端均产生该问题，以 macOS 端(.dmg)为例展开排查。解包产物，切入 `contents` 目录查看文件夹大小，执行 `du -sh ./*`，结果如下：

```
116K ./Contents/_CodeSignature 
999M ./Contents/app 
4.0K ./Contents/Info.plist 
196K ./Contents/MacOS 
4.0K ./Contents/PkgInfo 
16K ./Contents/Resources 
158M ./Contents/runtime
```

显然 **`Contents/app`（999MB）** 炸了。这也就是说：这次膨胀原因主要来自 **应用层打包进去的 jar/依赖/资源** 异常地多，初步怀疑是某个库发生了问题，将三份native包全都打包到一个native平台上了。

切入 `Contents/app` 执行 `du -sh ./*` ，结果如下：

```
 ...
 22M	./opencv-4.6.0-1.5.8-android-x86-b38c986c415ad7d34111fa1ff684a19a.jar
 26M	./opencv-4.6.0-1.5.8-ios-arm64-5a95a9fd33b458cf8dc8538fff16.jar
 28M	./opencv-4.6.0-1.5.8-ios-x86_64-d3cdf6cb93ba33f2240a97fd5193.jar
 24M	./opencv-4.6.0-1.5.8-linux-arm64-91b0d28db0dcbe847ead233f99a2831.jar
 22M	./opencv-4.6.0-1.5.8-linux-armhf-4d45d47f293943abde4163761b744fc.jar
 27M	./opencv-4.6.0-1.5.8-linux-ppc64le-511dfd3698bebebd724d4052e6a34b90.jar
 27M	./opencv-4.6.0-1.5.8-linux-x86_64-91c04431ec13e27014c25b8f77ece6.jar
 28M	./opencv-4.6.0-1.5.8-linux-x86-941136bbfad2956a86b10f9242fad34.jar
 20M	./opencv-4.6.0-1.5.8-macosx-arm64-699b23fa8d64ced8f96a65d012ff48.jar
 25M	./opencv-4.6.0-1.5.8-macosx-x86_64-855f22d26a3e7eb65122adacf1e5cee4.jar
 29M	./opencv-4.6.0-1.5.8-windows-x86_64-149da917d80e13db6cac72fd53170cc.jar
 27M	./opencv-4.6.0-1.5.8-windows-x86-e136927b1d9446f968ea2bd45dfa13e.jar
 ...
```

这就很显然了，验证了猜想是对的。明明是macOS平台的包，却连 windows 及 linux 的jar都被打包进来，所以导致了包体积暴涨。下一步是排查最终的罪魁祸首，是谁干了这件蠢事。回到项目中运行 `./gradlew :composeApp:dependencyInsight --configuration desktopRuntimeClasspath --dependency javacv-platform`，输出如下：

![image-1.png](/legacy-assets/package-size-incre-md/image-1.png)

水落石出，结果显示是 `cmp-image-pick-n-crop-jvm:1.1.2` 这个库依赖 `org.bytedeco:javacv-platform:1.5.8` 又依赖 `org.bytedeco:opencv-platform:4.6.0-1.5.8`。`cmp-image-pick-n-crop` 是我在Github上找的一个用来裁剪图片的第三方库，它的JVM平台包依赖了 `*-platform` 全家桶，导致暴增。我在本次更新的改动中将其版本从 `1.1.1` 升级到 `1.1.2` 才出现这个问题，看来是作者在更新他的库依赖时犯了个低级错误。

修复很简单，回退到 `1.1.1` 即可解决，但是治标不治本。本着开源精神至上的原则我把该库fork并拉了下来准备直接修并提PR，结果这才发现这是个假开源项目。源代码是空的，只有个示例app。对印度人的刻板印象再次加深。无奈只好提了个issue作罢，但估计也不会被理睬，看commit日期这个库已经被放弃维护了，令人感叹。

## 案例二

2026年1月28日，发现v1.0.4版本桌面端安装包体积再次出现异常增大，但这次涨幅不如上次，且只有 Win / Linux 平台受影响。

![image-2.png](/legacy-assets/package-size-incre-md/image-2.png)

这次以 Linux 平台 (.deb) 为例进行排查，还是老方法，解包然后看谁变大了。分别对新老版本安装包运行 `du -h -d 4 old | sort -h | tail -n 30` 查看：

```
# old
4.0K    old/opt/bandoristationm/share
4.0K    old/opt/bandoristationm/share/doc
 20K    old/opt/bandoristationm/bin
129M    old/opt/bandoristationm/lib/app
168M    old/opt/bandoristationm/lib/runtime
298M    old
298M    old/opt
298M    old/opt/bandoristationm
298M    old/opt/bandoristationm/lib

# new
4.0K    new/opt/bandoristationm/share
4.0K    new/opt/bandoristationm/share/doc
 24K    new/opt/bandoristationm/bin
129M    new/opt/bandoristationm/lib/app
480M    new/opt/bandoristationm/lib/runtime
610M    new
610M    new/opt
610M    new/opt/bandoristationm
610M    new/opt/bandoristationm/lib
```

`lib/runtime` 炸了，显然这次不是依赖包的问题，而是JRE出了差错，就像没被裁剪一样。在新版本包中运行 `find new/opt/bandoristationm/lib/runtime/lib -type f -print0 | xargs -0 ls -lnS | head -n 30`，结果如下：

```
-rw-r--r--  1 501  20  209861688 Jan 28 17:05 new/opt/bandoristationm/lib/runtime/lib/libcef.so
-rw-r--r--  1 501  20  147634191 Jan 28 17:05 new/opt/bandoristationm/lib/runtime/lib/modules
-rw-r--r--  1 501  20   26726528 Jan 28 17:05 new/opt/bandoristationm/lib/runtime/lib/server/libjvm.so
-rw-r--r--  1 501  20   10717392 Jan 28 17:05 new/opt/bandoristationm/lib/runtime/lib/icudtl.dat
-rw-r--r--  1 501  20   10715134 Jan 28 17:05 new/opt/bandoristationm/lib/runtime/lib/ct.sym
...
```

一上来就看懂了，怎么混进来个庞然大物 `libcef.so`，我这是不知道被谁塞了整套 Chromium 啊。翻了翻过去的 commit 记录，定位了罪魁祸首：在 Android Studio 建议迁移 gradle 后，gradle 在升级到9.0.0的同时，顺手给我塞了个 `gradle-daemon-jvm.properties`。我没有在意，但是这个配置文件里面设置了 `toolchainVendor=JETBRAINS`，即指定 JBR 为 Gradle Daemon 的运行时，而上面的URL里面又指定了 JBR 的版本是带 JCEF 的版本：

- Linux: `jbrsdk_jcef-21.0.9-linux-x64-b895.149.tar.gz`
- Windows: `jbrsdk_jcef-21.0.9-windows-x64-b895.149.zip`
- macOS: `jbrsdk_jcef-21.0.9-osx-aarch64-b895.149.tar.gz`

这也导致当workflow在跑时，Gradle构建时，不会再用我指定的 temurin，而是现场下带JCEF 的 JBR 用，自然打包时把 libcef.so 等一系列不需要的东西也拐进来了。

解决：直接rollback即可。

## 经验总结

遇到包体积暴涨不用慌，凡事皆有迹可循。桌面端打包（Compose Desktop/jpackage）有个特点：**最终体积主要由两部分决定**：

- **应用层**：`lib/app`（jar、资源、代码）-> 通常增长是渐进的
- **运行时层**：`lib/runtime`（JRE/JBR、native、资源包）-> **一旦策略变了就是断崖式增长**

不要用“总大小”当指标，而是要抓“结构”，把体积拆成可解释的结构指标，迅速归因：

- `app` 变大 → 依赖/资源/重复打包
- `runtime` 变大 → JDK/JBR 变更、jlink 失效、引入 JCEF、debug 符号等
