---
title: 集成ffmpeg
date: '2026-03-03T11:29:58+08:00'
updated: '2026-03-03T04:33:08.106Z'
legacyPath: /2026/03/03/集成ffmpeg-md/
categories:
  - Android
tags:
  - NDK
  - FFmpeg
  - 音视频
---

**该篇内容为原博客博文，原上传于2022年2月12日。可能已过时，仅作补档用途，谨慎参考！**

### 前言

FFmpeg是一款开源音视频处理工具，简单易用，功能强大。将FFmpeg移植到Android平台上，可以使得我们在从事 Android 音视频开发时如虎添翼。上回我们已经在 ubuntu 上初步配置和安装了 FFmpeg，但这样还是远远不够的。接下来就探讨一下如何在 Android Studio 中集成FFmpeg。

### 适用版本

- FFmpeg 5.0 "Lorentz"
- ubuntu 20.04
- NDK 21.4
- CMake 3.18
- Android Studio Bumblebee 2021.1.1

其中NDK和CMake为方便演示使用的是AS自带的版本，如果使用自己安装的版本可以参考官方教程进行配置。

### Step1. 重新编译FFmpeg

FFmpeg本身是C语言编写的，所以我们需要使用NDK将其编译成适用于Android平台的so库，并通过jni进行调用。所以仅由我们在上一篇中简单的配置而产生的FFmpeg库是完全不能胜任的，需要设置必要的配置参数，重新编译。

首先运行

```
make uninstall & make distclean
```

以卸载和清除上次编译产生的文件。由于需要设置的参数较多，这一次我们选择编写Shell脚本来对FFmpeg进行配置和编译。这里我的脚本参考了同组学长 CarriSun 的写法，具体如下：

```
TOOLCHAIN=$HOME/Android/Sdk/ndk/21.4.7075529/toolchains/llvm/prebuilt/linux-x86_64

export PATH=$PATH:$TOOLCHAIN/bin

CROSS_PREFIX=aarch64-linux-android
CROSS_PREFIX_CLANG=aarch64-linux-android21
PREFIX=$HOME/open/ffmpeg
ANDROID_API=21
ARCH=arm64
CPU=armv8-a

export CC=$CROSS_PREFIX_CLANG-clang
export CXX=$CROSS_PREFIX_CLANG-clang++

./configure \

--prefix=$PREFIX \
--enable-shared \
--disable-static \
--enable-cross-compile \
--disable-doc \
--cross-prefix=$CROSS_PREFIX- \
--cc=$CC \
--cxx=$CXX \
--sysroot=$TOOLCHAIN/sysroot \
--extra-cflags="-isysroot $TOOLCHAIN/sysroot -isystem $TOOLCHAIN/sysroot/usr/include/aarch64-linux-android -D__ANDROID_API__=$ANDROID_API -U_FILE_OFFSET_BITS" \
--arch=$ARCH \
--cpu=$CPU \
--target-os=android

make clean
make -j4
make install

echo "Build FFmpeg on arm64 finished."
```

TOOLCHAIN 指定了编译时的工具链，ARCH 和 CPU 指定了目标平台支持的架构和CPU（重要）。

对该脚本 chmod 和执行后，我们就重新编译出了其中一种适用于 Android 平台的 FFmpeg 了。转到安装目录下，可以看到include目录下的头文件和lib目录下的动态库。

### step2. 配置Android Studio，导入动态库

打开Android Studio选择已有的项目（或者新建Native C++项目）。在模块级 build.gradle 中加入如下代码：

```
android {
    ...

    externalNativeBuild {
        cmake {
            path = "CMakeLists.txt"
            version = "3.18.1"
        }
    }

    defaultConfig {
        ...

        ndk{ abiFilters 'arm64-v8a' }

        ...
    }
}
```

其中cmake项是配置CMakeLists的路径和CMake的版本。
默认情况下，Gradle（无论是通过 Android Studio 使用，还是从命令行使用）会针对所有非弃用 ABI 进行构建。要限制应用支持的 ABI 集，请使用 abiFilters。如这里我填入了arm64-v8a，正是对应了编译FFmpeg时指定的目标CPU和架构。如果这里不设置abiFilter的话，之后构建app会出现问题。

关于abi，强烈建议读一下官网的说明：[Android ABI](https://developer.android.google.cn/ndk/guides/abis#gradle)

接下来，我们将编译生成的FFmpeg目录下include目录复制到app目录下，并创建cpp/arm64-v8a目录，且将FFmpeg/lib目录下所有so库复制过来。然后，我们就可以准备着手写CMakeList了：

```
cmake_minimum_required(VERSION 3.18)

project(jnitest C)

set(CMAKE_C_STANDARD 99)

aux_source_directory(/home/eynnzerr/open/AndroidProjectX/MediaLearning/app/cpp DIR_LIB)

add_library(jnitest SHARED ${DIR_LIB})

include_directories(include)

add_library(avcodec SHARED IMPORTED)
set_target_properties(avcodec PROPERTIES IMPORTED_LOCATION ${CMAKE_SOURCE_DIR}/libs/${CMAKE_ANDROID_ARCH_ABI}/libavcodec.so)

add_library(avdevice SHARED IMPORTED)
set_target_properties(avdevice PROPERTIES IMPORTED_LOCATION ${CMAKE_SOURCE_DIR}/libs/${CMAKE_ANDROID_ARCH_ABI}/libavdevice.so)

add_library(avfilter SHARED IMPORTED)
set_target_properties(avfilter PROPERTIES IMPORTED_LOCATION ${CMAKE_SOURCE_DIR}/libs/${CMAKE_ANDROID_ARCH_ABI}/libavfilter.so)

add_library(avformat SHARED IMPORTED)
set_target_properties(avformat PROPERTIES IMPORTED_LOCATION ${CMAKE_SOURCE_DIR}/libs/${CMAKE_ANDROID_ARCH_ABI}/libavformat.so)

add_library(avutil SHARED IMPORTED)
set_target_properties(avutil PROPERTIES IMPORTED_LOCATION ${CMAKE_SOURCE_DIR}/libs/${CMAKE_ANDROID_ARCH_ABI}/libavutil.so)

add_library(swresample SHARED IMPORTED)
set_target_properties(swresample PROPERTIES IMPORTED_LOCATION ${CMAKE_SOURCE_DIR}/libs/${CMAKE_ANDROID_ARCH_ABI}/libswresample.so)

add_library(swscale SHARED IMPORTED)
set_target_properties(swscale PROPERTIES IMPORTED_LOCATION ${CMAKE_SOURCE_DIR}/libs/${CMAKE_ANDROID_ARCH_ABI}/libswscale.so)

target_link_libraries(
        jnitest
        avcodec
        avdevice
        avfilter
        avformat
        avutil
        swresample
        swscale
)
```

以上就是添加FFmpeg的共享库并将它们全部链接进来。至此，准备工作全部完成，sync一下项目即可。

### Step.3 测试

cpp目录下引入jni头文件后，编写测试代码：

```
#include "jni.h"

#ifndef _Included_JNITest
#define _Included_JNITest

#ifdef __cplusplus
extern "C" {
#endif
#include <libavutil/avutil.h> //库导入放在extern C内！FFmpeg是C编写的。

JNIEXPORT jstring JNICALL Java_com_eynnzerr_medialearning_MainActivity_getString(JNIEnv *env, jobject thiz) {
    return (*env)->NewStringUTF(env, avutil_configuration());
}

#ifdef __cplusplus
}
#endif
#endif
```

这里简单返回一下FFmpeg的配置信息。对应原生方法：

```
    companion object {
        init {
            System.loadLibrary("jnitest")
        }
    }
    private external fun getString(): String
```

我们在Log中打印出来看看：

```
Log.d(TAG, "onCreate: msg from JNI: ${getString()}")
```

开始构建app。注意由于这里我们选择的架构是arm64-v8a，因此app只能在支持该架构的手机上（虚拟机或实机）运行，Android Studio会给出这方面的警告。想要增加支持的架构，就可以指定不同的CPU多次编译FFmpeg，并在abiFilter中添加。

运行app，可以看到日志中确实输出了相关信息，证明FFmpeg已经成功移植到了Android平台。

### 报错记录

总体上来说，第一次尝试AS集成FFmpeg，整个过程还算比较顺利，只有在最后报了一些错误，也都已经解决，但秉持会有和我一样的小白也可能遇到同样的问题，特此记录，相互学习。

#### 动态库路径问题

**信息**：ffmpeg: error while loading shared libraries: libavdevice.so.59: cannot open shared object file: No such file or directory

**原因**：通过源码安装软件未进行库搜索路径配置，系统找不到ffmpeg动态库路径。

**解决**：`sudo vim /etc/ld.so.conf` 加上ffmpeg的lib文件夹路径，然后`sudo ldconfig`。

#### 架构匹配问题

**信息**：
1. clang: error: linker command failed with exit code 1 (use -v to see invocation)
2. C/C++: /.../Android/Sdk/ndk/21.4.7075529/toolchains/llvm/prebuilt/linux-x86_64/lib/gcc/i686-linux-android/4.9.x/../../../../i686-linux-android/bin/ld: error: ../../../../libs/libswscale.so: incompatible target
3. C/C++: ../../../../cpp/main.c:16: error: undefined reference to 'avutil_configuration'

**原因**：（在上面已经提到过）第一次移植ffmpeg时，app总是不能通过编译。对代码反复修改后仍未解决，并报出以上错误。其实从第二条错误信息中的`incompatible target`就可以看出，这有可能是因为目标架构不匹配的原因。下面是stack overflow上热心码友给出的解释：

> The error you're getting means that ndk-build is trying to use your .so file while compiling your module for an incompatible target.
> Android supports several cpu architectures (armeabi, armeabi-v7a, arm64-v8a, x86, x86_64, mips, mips64). You can choose which one you want to support using the APP_ABI variable from Application.mk. If you set it to all, ndk-build will try to use this .so file you're referencing for each of these architectures, but this cannot work.
> Your .so file must have been compiled for Android platforms, and you need to have a different version of it for each architecture you're supporting. You can give a dynamic reference to the right .so file, such as LOCAL_SRC_FILES := $(TARGET_ARCH_ABI)/libslabhidtouart.so so it looks for your .so file under armeabi-v7a folder when compiling for armeabi-v7a, under x86 for x86, etc.
> Of course you need to provide these .so files. If you can't get .so files for all the supported architectures, you'll have to restrict your APP_ABI to the architectures of the .so file you have. You can determine the architecture your .so file has been compiled for using readelf.

然而，现如今互联网上大部分博客都没有强调ffmpeg移植的架构匹配性问题，有几篇中有所涉及，但也没有解释原因 ~~（这里再次感叹音视频学习资料匮乏）~~。

**解决**：首先在编译ffmpeg时，通过--cpu参数和--arch指定目标CPU与架构，再在android studio中配置ndk的abiFilter。

#### Android Studio 兼容性问题

**信息**：2 files found with path ‘lib/armeabi-v7a/libbufferhub.so‘ from inputs

**原因**：早期版本的Android Gradle插件要求使用以下命令显式打包CMake外部本机内部版本使用的所有预构建库 jniLibs：

```
sourceSets {
    main {
        jniLibs.srcDirs = ['libs']
    }
}
```

使用Android Gradle Plugin 4.0时，不再需要上述配置，并且会导致构建失败。现在，外部本机构建会自动打包这些库，因此将jniLibs结果与库明确打包在一起。为避免生成错误，只需jniLibs从build.gradle文件中删除配置即可。绝大多数过时的博客都因此极具误导性。

**解决**：在app:build.gradle中去掉sourceSets的设置   
