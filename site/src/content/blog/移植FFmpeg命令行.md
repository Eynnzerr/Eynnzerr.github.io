---
title: 移植FFmpeg命令行
date: '2026-03-03T12:33:50+08:00'
updated: '2026-03-03T04:39:05.356Z'
legacyPath: /2026/03/03/移植FFmpeg命令行/
categories:
  - Android
tags:
  - NDK
  - FFmpeg
  - 音视频
---

**该篇内容为原博客博文，原上传于2022年2月27日。可能已过时，仅作补档用途，谨慎参考！**

### 前言

上次，我们初步对FFmpeg进行了交叉编译及简单移植。然而，FFmpeg的强大之处在于使用简单的命令行完成艰巨的音视频处理。如果仅仅是集成众多动态库，我们只能使用库中提供的函数编写代码完成功能，相比于使用命令行，对于初学者来说是比较复杂和困难的方法。所以这一次，我们将尝试移植FFmpeg的命令行，直接通过命令调用FFmpeg。然而，笔者的初次移植血泪史揭示，现有的大量博客都是过时的，按照他们的步骤来做，会导致移植失败，白白浪费心力。需要在一般步骤的基础上，加上其他必要的操作。

### 修改configure文件

在之前的步骤中，我们并没有深入讨论源码目录下的configure文件本身的内容，也没有提到编译脚本为什么这么写，哪些参数是必须配置的。接下来，我们打开configure文件,首先对FFmpeg编译生成的动态库的格式进行设置：

```
vim configure
:/SLIBNAME_WITH_MAJOR
```

**注意本文基于ffmpeg5.0，其他版本configure文件内容可能并不一致。**

查看并找到下面的内容：

```
SLIBNAME_WITH_MAJOR='$(SLIBNAME).$(LIBMAJOR)' 
LIB_INSTALL_EXTRA_CMD='$$(RANLIB) "$(LIBDIR)/$(LIBNAME)"' 
SLIB_INSTALL_NAME='$(SLIBNAME_WITH_VERSION)' 
SLIB_INSTALL_LINKS='$(SLIBNAME_WITH_MAJOR) $(SLIBNAME)'
```

将其修改为：

```
SLIBNAME_WITH_MAJOR='$(SLIBPREF)$(FULLNAME)-$(LIBMAJOR)$(SLIBSUF)'
LIB_INSTALL_EXTRA_CMD='$$(RANLIB)"$(LIBDIR)/$(LIBNAME)"'
SLIB_INSTALL_NAME='$(SLIBNAME_WITH_MAJOR)'
SLIB_INSTALL_LINKS='$(SLIBNAME)'
```

这一步是许多博客都提到过的，其原因在于，FFmpeg默认编译生成的so库会在后缀后面带上版本号，如libavcodec.so.57.107.100。Android Studio不支持导入这样的库。**实际上，FFmpeg也会生成一般命名的so库**，只是经过上面的修改后，在安装目录下的lib目录中就只会生成一般命名的so库了，这会使得lib目录更加简洁美观。

接下来，我们找到`if test "$target_os" = android`处，注意到这里对应上了我们在编译脚本中配置的参数target-os=android，这里规定了一些默认配置，然而仔细观察，不难发现其中有些地方是有问题的：

```
if test "$target_os" = android; then
    cc_default="clang"
fi

ar_default="${cross_prefix}${ar_default}"
cc_default="${cross_prefix}${cc_default}"
cxx_default="${cross_prefix}${cxx_default}"
nm_default="${cross_prefix}${nm_default}"
pkg_config_default="${cross_prefix}${pkg_config_default}"
if ${cross_prefix}${ranlib_default} 2>&1 | grep -q "\-D "; then
    ranlib_default="${cross_prefix}${ranlib_default} -D"
else
    ranlib_default="${cross_prefix}${ranlib_default}"
fi
strip_default="${cross_prefix}${strip_default}"
windres_default="${cross_prefix}${windres_default}"
```

首先，上面的脚本没有设置当 target-os 为 android 时，c++ 的默认编译器；此外，其将ar,cc,cxx等等需要的参数均设置成以 cross_prefix 为前缀，然而找到我们工具链的bin目录下（如笔者这里是ndk/21.4.7075529/toolchains/llvm/prebuilt/linux-x86_64/bin），可以发现相应的工具前缀是llvm-，而不是脚本里设置的cross_prefix，即aarch64-linux-android-。如果不修改，就会在最后移植时导致一系列问题。此外，其对pkg_config的配置也有问题。我们的工具链并没有内置pkg_config，所以这里也要改成我们自己安装的pkg_config。我们考虑以上列出的问题，将以上代码修改如下：

```
if test "$target_os" = android; then
    cc_default="clang"
    cxx_default="clang++"
fi

ar_default="llvm-${ar_default}"
cc_default="${cross_prefix}${cc_default}"
cxx_default="${cross_prefix}${cxx_default}"
nm_default="llvm-${nm_default}"
pkg_config_default="${pkg_config_default}"
if ${cross_prefix}${ranlib_default} 2>&1 | grep -q "\-D "; then
    ranlib_default="llvm-${ranlib_default} -D"
else
    ranlib_default="llvm-${ranlib_default}"
fi
strip_default="llvm-${strip_default}"
windres_default="${cross_prefix}${windres_default}"
```

注意到我们将涉及到前缀问题的参数均修改为了正确的前缀（有的参数暂时用不到，就没有修改），此外,我们将cxx_default重写为clang++。我们没有改写下面的cc_default和cxx_default，因为我们的脚本中已经设置了正确的cc和cxx，不会用到错误的默认值。到这里，configure就算改好了。这里我列出的代码仅以我自己的配置为准，务必要根据自己的工具链选择是否改写。
我们再回头看一眼编译脚本：

```
TOOLCHAIN=$HOME/Android/Sdk/ndk/21.4.7075529/toolchains/llvm/prebuilt/linux-x86_64

export PATH=$PATH:$TOOLCHAIN/bin

CROSS_PREFIX=aarch64-linux-android
CROSS_PREFIX_CLANG=aarch64-linux-android21
PREFIX=$HOME/open/FFmpeg/src/ffmpeg-5.0-arm64
ANDROID_API=21
ARCH=aarch64
CPU=armv8-a

# configure默认的CC与CXX路径是错误的，需要修正
export CC=$CROSS_PREFIX_CLANG-clang
export CXX=$CROSS_PREFIX_CLANG-clang++

./configure \
--prefix=$PREFIX \
--enable-shared \
--enable-postproc \
--enable-gpl \
--enable-jni \
--disable-static \
--enable-cross-compile \
--disable-doc \
--cross-prefix=$CROSS_PREFIX- \
--cc=$CC \
--cxx=$CXX \
--sysroot=$TOOLCHAIN/sysroot \
--extra-cflags="-D__ANDROID_API__=$ANDROID_API -U_FILE_OFFSET_BITS" \
--arch=$ARCH \
--cpu=$CPU \
--target-os=android

make clean
make -j4
make install

echo "build android ffmpeg finished."
```

运行脚本，我们像上次一样，在安装目录得到了bin,include,lib,share几个目录，表示编译成功。

### 移植命令行

首先，我们像上次一样，拷贝lib目录下所有so库至我们的Android项目中。接下来，我们首先考虑如何实现命令行的移植。我们在使用ffmpeg命令的时候，实际上是在将命令行参数传给ffmpeg的main函数，并由main函数具体执行命令。那么我们要做的事情也就清晰了，即在android项目中使用ffmpeg的main函数，并向其传递参数。接下来的步骤如下：

我们拷贝整个include目录。这里我直接将libs和include目录放在和src同级（注意我们不建议在实际项目中这样组织目录层次。官方推荐的做法是将原生相关的文件统一放在cpp目录下管理）。可以看见，在include目录中，是我们所需要的众多头文件。

接下来，我们回到ffmpeg源码目录，这里有我们需要用到的一些文件。首先是fftools文件夹，这里是命令行调用ffmpeg的工具。我们复制其中的cmdutils.h和ffmpeg.h到android项目的include文件夹下（别忘了include是我们存放众多头文件的地方），再把cmdutils.c, ffmpeg.c, ffmpeg_filter.c, ffmpeg_hw.c, ffmpeg_opt.c五个文件复制到libs目录下。此外，我们还需要源码目录下编译后生成的config.h，将它也复制到include目录下。**注意这里文件存放的位置不是绝对的，只要保证能合理地编写CMakeLists即可**。

到此，我们的目录结构如下：

![结构1](https://s2.loli.net/2022/02/27/ZoAg5efELPjxDHi.png)

![结构2](https://s2.loli.net/2022/02/27/3lTunBPNMsfkJvD.png)

接着，我们还需要修改其中的一部分代码，以使其适应Android APP下的应用情景。参考博客：https://blog.csdn.net/yhaolpz/article/details/77146156#commentBox

1. 修改日志输出源
我们希望能在调用ffmpeg时，将其日志输出导入至AS的logcat中，方便我们的开发与调试。为此，我们首先引入android的log库。在CMakeLists中新增如下代码：

```
find_library(log-lib log)
...
target_link_libraries(
    ...
    ${log-lib}
)
```

接下来，在include目录写一个androidlog.h文件：

```c
#ifdef ANDROID
#include <android/log.h>
#ifndef LOG_TAG
#define  MY_TAG   "MYTAG"
#define  AV_TAG   "AVLOG"
#endif
#define LOGE(format, ...)  __android_log_print(ANDROID_LOG_ERROR, MY_TAG, format, ##__VA_ARGS__)
#define LOGD(format, ...)  __android_log_print(ANDROID_LOG_DEBUG,  MY_TAG, format, ##__VA_ARGS__)
#define  XLOGD(...)  __android_log_print(ANDROID_LOG_INFO,AV_TAG,__VA_ARGS__)
#define  XLOGE(...)  __android_log_print(ANDROID_LOG_ERROR,AV_TAG,__VA_ARGS__)
#else
#define LOGE(format, ...)  printf(MY_TAG format "\n", ##__VA_ARGS__)
#define LOGD(format, ...)  printf(MY_TAG format "\n", ##__VA_ARGS__)
#define XLOGE(format, ...)  fprintf(stdout, AV_TAG ": " format "\n", ##__VA_ARGS__)
#define XLOGI(format, ...)  fprintf(stderr, AV_TAG ": " format "\n", ##__VA_ARGS__)
#endif
```

打开ffmpeg.c，引入头文件`#include "androidlog.h"`，并实现原本为空的logg_callback_null函数：

```c
static void log_callback_null(void *ptr, int level, const char *fmt, va_list vl)
{
    static int print_prefix = 1;
    static int count;
    static char prev[1024];
    char line[1024];
    static int is_atty;
    av_log_format_line(ptr, level, fmt, vl, line, sizeof(line), &print_prefix);
    strcpy(prev, line);
    if (level <= AV_LOG_WARNING){
        XLOGE("%s", line);
    }else{
        XLOGD("%s", line);
    }
}
```

在ffmpeg.c的main函数第一行加入如下代码：

```c
av_log_set_callback(log_callback_null);
```

这样，以后在调用ffmpeg命令时，就可以像在shell里一样在logcat获得ffmpeg输出的日志信息。

2. 执行命令后清除数据并保留进程
在ffmpeg.c的ffmpeg_cleanup中末尾加上如下代码：

```c
nb_filtergraphs = 0;
nb_output_files = 0;
nb_output_streams = 0;
nb_input_files = 0;
nb_input_streams = 0;
```

在ffmpeg.c的main函数的return语句调用前增加如下代码：

```c
ffmpeg_cleanup(0);
```

再修改cmdutils.c中的exit_program函数如下：

```c
int exit_program(int ret)
{
   return ret;
}
```

注意由于我们修改了函数的返回值，故还需要到cmdutils.h中修改对应的函数声明：

```c
int exit_program(int ret);
```

以上都完成后，不要忘了在ffmpeg.h中加上对main函数的声明，否则我们调用不到ffmpeg.c的main函数。大多数博客都喜欢将main函数的函数名改写为run, exec之类的其他名称，这个因人而异，修不修改没有问题。
到此，对ffmpeg源文件的修改就结束了，大多数博客也就到此结束了，他们可以愉快地在android中使用ffmpeg命令了。但此时如果我们尝试启动APP，会发现AS报出一长串的错误，都是找不到头文件。此时不要慌张，回到ffmpeg源码目录下寻找缺失的头文件并逐一复制即可。这里我丢失的头文件如下，可供参考：

- compat目录下:va_copy.h
- libavcodec目录下:matops.h
- libavformat目录下：os_support.h
- libavutil目录下：aarch64等架构目录（主要需要的是其中的timer.h）,internal.h,libm.h,thread.h,timer.h

再次启动APP，应该编译通过，APP正常启动。如果你的AS依然报错，且不是丢失头文件，而是各种语法问题（如内联汇编限制符），你可以先尝试修正，如果始终不行，请检查ffmpeg编译脚本是否正确编写，目标架构等参数是否配置正确。

我们可以编写一个测试用例，这里我之前有一个将wav格式音频转码为aac格式的业务需求，是使用android的MediaCodec API实现的，其代码逻辑复杂冗长，我们尝试使用简单的ffmpeg命令实现这个需求。

编写如下工具类：

```kotlin
object FFmpegUtils {
    init {
        System.loadLibrary("jnitest")
    }

    fun WAV2AAC(pcmPath: String, aacPath: String) {
        val command = arrayOf(
            "ffmpeg",
            "-i",
            pcmPath,
            aacPath
        )
        exec(command)
    }

    private external fun exec(args: Array<String>)
}
```

我们先是加载了native库，并且声明了一个native方法，用于接收命令参数。exec函数的原形如下：

```c
JNIEXPORT void JNICALL
Java_com_eynnzerr_medialearning_utils_FFmpegUtils_exec(JNIEnv *env, jobject thiz,
                                                       jobjectArray args) {
    int i = 0;
    int argc = 0;
    char **argv = NULL;
    jstring *strr = NULL;

    if (args != NULL) {
        argc = (*env)->GetArrayLength(env, args);
        argv = (char **) malloc(sizeof(char *) * argc);
        strr = (jstring *) malloc(sizeof(jstring) * argc);

        av_log(NULL, AV_LOG_INFO, "argc is %d", argc);

        for (i = 0; i < argc; i ++) {
            strr[i] = (jstring) (*env)->GetObjectArrayElement(env, args, i); // strr将传入的kotlin string转为jstring
            argv[i] = (char *) (*env)->GetStringUTFChars(env, strr[i], 0);  // argv将jstring转化为UTF Chars
            av_log(NULL, AV_LOG_INFO, "receive argv: %s", argv[i]);
        }
    }

    main(argc, argv);

    for(i = 0; i < argc; i ++) {
        (*env)->ReleaseStringUTFChars(env, strr[i], argv[i]);
    }
    free(argv);
    free(strr);
}
```

实际测试，完美运行，成功移植FFmpeg命令行至Android平台。
