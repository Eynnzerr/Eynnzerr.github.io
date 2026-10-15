---
title: 'JVM 内存与垃圾回收：从一次对象分配追到生命周期终点'
description: '沿着对象创建、引用传递、失去可达性和回收的过程，串起运行时数据区、GC Roots、分代与区域化收集，以及类卸载和资源关闭。'
date: '2026-03-05T13:48:53+08:00'
categories: [Java, JVM]
tags: [JVM, 内存管理, 垃圾回收, G1, 引用]
updated: '2026-10-15'
---

理解 JVM 内存，可以沿着一个对象的生命周期问四个问题：在哪里分配，谁还引用它，何时可以回收，回收后哪些资源真正被释放。运行时数据区描述第一个问题，可达性描述第二个问题，垃圾收集器处理第三个问题，显式资源管理补上第四个问题。

这些概念连接起来后，许多现象都有了具体原因：方法返回后对象为什么还在，两个对象互相引用为什么仍能回收，堆没有占满为什么进程已经消耗很多内存。

## 先分清方法执行状态与对象本身

JVM 规范定义的运行时数据区可以分成两组：

| 数据区 | 共享关系 | 主要作用 |
| --- | --- | --- |
| 程序计数器 `pc` | 每线程一份 | 执行非 native 方法时，记录当前正在执行的 JVM 指令地址 |
| Java 虚拟机栈 | 每线程一份 | 保存方法调用的栈帧，包括局部变量、操作数栈等 |
| 本地方法栈 | 按实现提供 | 支持 native 方法的执行 |
| 堆 | 线程共享 | 为对象实例和数组提供存储 |
| 方法区 | 线程共享 | 保存类的结构信息、方法相关数据与运行时常量池等 |

例如，一个方法创建数组并把它返回：

```java
/** Creates a buffer that remains usable after this method returns. */
static byte[] createBuffer() {
    byte[] buffer = new byte[1024];
    return buffer;
}
```

在 JVM 的抽象执行模型中，局部变量 `buffer` 保存引用，数组是堆中的对象。方法返回后，这次调用的栈帧结束；返回值把数组引用交给了调用方，数组的生命周期可以继续。

JIT 还可能根据逃逸分析等优化消除某些分配。因此，讨论实际占用时，需要区分语言中的对象创建语义与某次编译后的物理分配。这里返回的数组通常需要由调用方继续使用，而完全局限于局部计算的临时对象可能存在更多优化机会。

## 方法区与 Metaspace 处于不同抽象层

方法区是 JVM 规范中的概念。规范将它描述为堆的逻辑组成部分，物理内存布局与回收方式则由具体 JVM 实现决定。

现代 HotSpot 把类元数据放在本地内存中的 Metaspace。理解具体进程内存时，还要分别看其他部分：

- 普通实例、数组以及 `String` 对象属于 Java 堆的管理范围。
- 类元数据主要由 Metaspace 管理。
- JIT 编译出的机器码使用代码缓存。
- 线程栈、直接缓冲区和 JVM 自身数据结构也会消耗进程内存。

所以 `-Xmx` 设置的是最大 Java 堆大小，进程的内存占用还包含其他部分。排查 `OutOfMemoryError: Java heap space` 与 `OutOfMemoryError: Metaspace`，应当沿不同的分配来源查找原因。

## 对象能否回收，取决于从外部还能不能到达

局部变量被赋为 `null`，只是删除了其中一条引用。对象可能仍在集合、缓存、回调或其他对象的字段中。

追踪式垃圾收集从一组根引用出发，沿对象之间的引用遍历。根入口通常来自活跃线程中的对象引用、运行时维护的类与静态数据、JNI 引用等。对象如果仍可通过强引用路径到达，就需要保留。

下面的两个节点互相引用：

```java
/** A node with one optional outgoing reference. */
final class Node {
    /** Neighbor in the object graph. */
    Node next;
}

/** Creates a cycle that is not returned or stored elsewhere. */
static void createCycle() {
    Node left = new Node();
    Node right = new Node();
    left.next = right;
    right.next = left;
}
```

方法返回后，若没有其他外部引用，这个环与根之间就没有路径：

```text
GC Roots       left → right
                 ↑       |
                 └───────┘
```

环内部有引用，却没有办法从根进入它。因此，追踪式收集器可以识别这一组不可达对象。单纯依赖引用计数归零的方案则会遇到这个环，因为两个节点的计数互相维持为正。

垃圾回收所关心的是当前可达关系。业务上已经不用、却仍被一个长期存活集合引用的对象，会继续保留。这正是托管内存中常见的泄漏形式：对象在业务生命周期之外仍然可达。

## 强、软、弱、虚引用改变保留规则

普通对象引用形成强可达路径。软引用、弱引用和虚引用则通过 `java.lang.ref` 中的类型，让程序参与更细致的生命周期管理。

| 引用 | 核心语义 | 使用时需要考虑的条件 |
| --- | --- | --- |
| 强引用 | 强可达对象会被保留 | 删除一条引用后，还要看其他强路径 |
| `SoftReference` | 对象只有软可达时，可由收集器按内存需求清除 | 保留时间受运行时策略影响，缓存容量需要独立设计 |
| `WeakReference` | 收集器判定对象弱可达时，会清除相应弱引用 | 获取结果随时可能变为 `null` |
| `PhantomReference` | 用于对象进入相应回收阶段后的通知与清理协作 | `get()` 始终返回 `null`，通常结合引用队列使用 |

这几种引用描述的是可达路径及其处理规则。对象通过 `new` 创建后，可能先被强引用持有，后来只剩弱引用，最终失去可达性；创建方式并没有给对象永久绑定某种引用等级。

弱引用适合让关联跟随对象的实际生命周期结束。需要稳定命中率、容量与淘汰规则的缓存，通常更适合明确的缓存策略。

## 找到垃圾之后，怎样让空间重新可用

存活判定和空间回收是两个连续步骤。经典回收思路可以从存活对象是否移动来看：

| 思路 | 回收动作 | 主要成本与结果 |
| --- | --- | --- |
| 标记清除 | 保留存活对象所在位置，回收其他空间 | 对象无需移动，但空闲空间可能分散 |
| 复制 | 将存活对象复制到目标区域，再回收源区域 | 需要目标空间，复制量取决于存活对象数量 |
| 标记整理 | 标记后移动存活对象，整理出连续空闲区域 | 减少碎片，同时需要搬迁对象并处理引用 |

例如一块区域中只有十分之一的对象存活，复制这些存活对象，再整体回收源区域，可能比逐个整理大量已死亡对象更合适。若大部分对象都存活，搬迁成本与目标空间需求又会成为重要因素。

具体收集器还需要处理并发修改：收集器遍历对象图时，应用线程可能正在改变引用。写屏障、记忆集等机制用于记录或维护这些变化，使收集过程仍然正确。使用复制还是整理，并不单独决定是否能够并发执行，也不直接决定停顿长短。

## 分代与 Region 把回收范围组织起来

许多程序中，临时对象数量多、存活时间短，长期存活对象则相对稳定。分代收集利用这种特征，把不同年龄的对象分开管理，减少每次都扫描整个堆的工作量。

在常见的 HotSpot 分代收集路径中，新对象通常先进入年轻代，年轻代回收时把仍存活的对象保留在 Survivor 区或晋升到老年代。TLAB 是在线程之间划分分配空间的一种方式：每个线程先在自己获得的小块堆空间中分配，降低分配时的竞争。TLAB 也由堆管理。

对象晋升受年龄、Survivor 容量和收集器策略共同影响。某个固定年龄阈值或固定的 Eden/Survivor 比例，只有放在对应收集器和配置中才有具体含义。

以 G1 为例，它把堆划分为多个 Region，用 Region 组成逻辑上的年轻代和老年代。年轻代回收和 Mixed GC 会选择不同的回收集合，把其中的存活对象疏散到其他 Region，再回收腾空的区域。Mixed GC 包含年轻代和一部分选中的老年代 Region。

G1 的停顿目标参与回收集合的选择，实际停顿还受存活数据量、引用处理和系统负载影响。日志中的 Young、Mixed、Full 对应不同的收集路径；判断某次回收代价时，应同时看收集器、触发原因、回收前后占用与停顿时间。

## 类也有生命周期

动态代理、插件和运行时生成代码会持续引入类元数据。普通类能否卸载，与定义它的类加载器能否被回收密切相关。

如果长期存活的对象仍然持有类加载器、某个 `Class` 对象或该类的实例，对应的类及其元数据可能继续存活。反过来，当相关引用关系已经断开，具备类卸载能力的收集周期才有机会回收这些元数据。

因此，Metaspace 增长需要结合类加载数量和类加载器的存活关系分析。动态加载本来就会带来增长；持续增长且卸载无法跟上时，再追踪哪些引用维持了这些类加载器的生命周期。

## 对象内存回收与资源关闭分别处理

一个文件读取器同时涉及 Java 对象和操作系统文件资源。文件什么时候关闭，应该由使用范围决定：

```java
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/** Reads the first line and closes the reader on every exit path. */
static String readFirstLine(Path path) throws IOException {
    try (var reader = Files.newBufferedReader(path)) {
        return reader.readLine();
    }
}
```

try-with-resources 在离开作用域时调用 `close()`，正常返回与异常退出都包含在这个范围内。文件资源可以及时关闭，相关 Java 对象的内存再由 GC 管理。

Finalization 在 JDK 18 被标记为弃用并计划移除，JDK 25 的 `Object.finalize()` API 仍带有这一标记。它的执行时机不能承担及时释放资源的责任。`Cleaner` 可以为某些非堆资源提供清理兜底，其清理状态应与被清理对象分开保存，避免清理动作本身强引用对象。常规使用路径仍以明确的 `close()` 为中心。

沿着这条生命周期排查问题时，先定位内存区域，再查对象或类加载器的引用路径，然后结合收集器日志观察回收效果。对于文件、连接等外部资源，则直接检查打开和关闭的配对关系。这几条线各自对应明确的证据，也能解释同一进程中看似矛盾的内存现象。

## 参考资料

- [JVM 规范第 2 章：运行时数据区与栈帧](https://docs.oracle.com/javase/specs/jvms/se25/html/jvms-2.html#jvms-2.5)
- [JDK 25 GC 调优指南：类元数据与 Metaspace](https://docs.oracle.com/en/java/javase/25/gctuning/other-considerations.html)
- [JDK 25：java.lang.ref 与可达性](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/lang/ref/package-summary.html)
- [JDK 25 GC 调优指南：G1](https://docs.oracle.com/en/java/javase/25/gctuning/garbage-first-g1-garbage-collector1.html)
- [Java 语言规范 12.7：类卸载](https://docs.oracle.com/javase/specs/jls/se25/html/jls-12.html#jls-12.7)
- [JDK 25：Object.finalize](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/lang/Object.html#finalize())
- [JDK 25：Cleaner](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/lang/ref/Cleaner.html)
