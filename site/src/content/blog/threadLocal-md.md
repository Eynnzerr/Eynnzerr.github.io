---
title: ThreadLocal 笔记
date: '2026-02-11T20:45:37+08:00'
updated: '2026-02-20T12:47:11.961Z'
legacyPath: /2026/02/11/threadLocal-md/
categories:
  - Java
tags:
  - Java
  - ThreadLocal
---

> 在 Java / JVM Kotlin 并发开发中，`ThreadLocal` 经常被用来保存“与一次请求/一次任务绑定的上下文信息”，比如 `traceId`、用户信息、租户信息、事务/会话上下文等。它看起来像“全局变量”，但又能做到线程隔离：**同一个 `ThreadLocal` 在不同线程里互不干扰**。

---

## 1. ThreadLocal 是什么

ThreadLocal 说到底也就是 Java 语言提供的一个泛型类，它的主要作用是**为变量包上一层壳**：正常来说，当多线程访问同一变量时，他们将持有相同的变量，访问同一个地址，从而也引入**线程不安全**的并发问题；当如果将这个变量包裹在 ThreadLocal 中，每个线程则将只会访问到各线程独立的、针对该变量的一份拷贝，实现变量的线程隔离。

核心特点：

- 变量是“线程作用域”（thread-scoped），不是“对象作用域”
- `set/get/remove` 都是对“当前线程”的数据操作
- 很适合承载上下文类信息，减少层层传参

---

## 2. 用法示例

````kotlin
import kotlin.concurrent.thread  
  
val name = ThreadLocal<String>()  
  
thread {  
    name.set("hello")  
    println("thread-1 name: ${name.get()}")  
}.join()  
  
thread {  
    name.set("world")  
    println("thread-2-name: ${name.get()}")  
}.join()
````

以上代码创建了一个`ThreadLocal<String>`，并在两个线程中为其设置了不同的值然后读取。输出结果为：

```
thread-1 name: hello
thread-2-name: world
```

---

## 3. 原理

很多人初看会以为 `ThreadLocal` 自己保存了“每个线程的值”，所有逻辑都在这个类中，包括网上很多过时的博客都会如此误导，说`TheadLocal`里放了张 Map，key 是 Thread 对象，value 是线程给变量赋的值。 实际上并非如此，`ThradLocal` 的源码轻量且直观，自己读一遍就能完全掌握其原理。

实际上，值不在 `ThreadLocal` 里，而在 `Thread` 里，存放在另一个数据结构：一个字段名为`threadLocals`的`ThreadLocalMap`中；`ThreadLocal` 只是作为 `ThreadLocalMap` 这张表的 key。

- 每个 `Thread` 对象内部维护两张`ThreadLocalMap`表：
  - `threadLocals`：普通 `ThreadLocal` 的存储
  - `inheritableThreadLocals`：`InheritableThreadLocal` 的存储（稍后介绍）
- `ThreadLocal` 更像是一把“钥匙”（key），用于在当前线程的表里定位 value。

```java
  // java.lang.Thread 中的成员变量
  ThreadLocal.ThreadLocalMap threadLocals = null;  
  ThreadLocal.ThreadLocalMap inheritableThreadLocals = null;
```

---

### 3.1. ThreadLocalMap 与弱引用 Entry

`ThreadLocalMap` 是 `ThreadLocal` 的内部静态类，底层不是 `HashMap`，而是一个数组：

- `Entry[] table` 存放键值对
- 使用**开放定址 + 线性探测** 解决冲突

```java
// ThreadLocalMap lazy 构造方法
// Entry 为其底层存储数据的成员数组
ThreadLocalMap(ThreadLocal<?> firstKey, Object firstValue) {  
    table = new Entry[INITIAL_CAPACITY];  
    int i = firstKey.threadLocalHashCode & (INITIAL_CAPACITY - 1);  
    table[i] = new Entry(firstKey, firstValue);  
    size = 1;  
    setThreshold(INITIAL_CAPACITY);  
}
```

最关键的是 `Entry`：

- **key 是 `ThreadLocal` 的弱引用（WeakReference）**
- **value 用一个强引用另外存储**

```java
static class Entry extends WeakReference<ThreadLocal<?>> {  
    /** The value associated with this ThreadLocal. */  
    Object value;  
  
    Entry(ThreadLocal<?> k, Object v) {  
        super(k);  
        value = v;  
    }  
}
```

**⚠️注意！**
这带来一个非常重要的内存泄漏隐患，在使用时需要注意：  如果 `ThreadLocal` 本身不再被外部强引用，GC 可能回收它使得 key 变成 `null` （弱引用特性），但 **value 仍可能被强引用挂在表里**，直到表在后续操作中被清理或线程结束。

---

### 3.2. get() 做了什么：从当前线程取表再查 key

```java
public T get() {  
    Thread t = Thread.currentThread();  
    ThreadLocalMap map = getMap(t);  
    if (map != null) {  
        ThreadLocalMap.Entry e = map.getEntry(this);  
        if (e != null) {  
            @SuppressWarnings("unchecked")  
            T result = (T)e.value;  
            return result;  
        }  
    }  
    return setInitialValue();  
}
```

方法总结：

1. 获取当前所在线程对象：`Thread t = Thread.currentThread()`
2. 获取当前线程的 ThreadLocalMap 对象：`ThreadLocalMap m = t.threadLocals`
3. 若表还未初始化： `m != null`，在 map 中按当前 `ThreadLocal` 查找 entry，命中则返回 `value`
4. 否则（或未命中）：走初始化逻辑 `setInitialValue()`

初始化值来源：

- 默认 `initialValue()` 返回 `null`
- 可通过覆写 `initialValue()` 或 `ThreadLocal.withInitial(supplier)` 提供初始值

---

### 3.3. set() 做了什么：在当前线程的 ThreadLocalMap 里放值

```java
public void set(T value) {  
    Thread t = Thread.currentThread();  
    ThreadLocalMap map = getMap(t);  
    if (map != null) {  
        map.set(this, value);  
    } else {  
        createMap(t, value);  
    }  
}

void createMap(Thread t, T firstValue) {  
    t.threadLocals = new ThreadLocalMap(this, firstValue);  
}
```

方法总结：

1. 拿当前线程 `t`
2. 取线程的`ThreadLocalMap`，没有就创建
3. 调用表的`set`方法，在 `ThreadLocalMap` 中插入或覆盖

```java
private void set(ThreadLocal<?> key, Object value) {  
    // 计算哈希
    Entry[] tab = table;  
    int len = tab.length;  
    int i = key.threadLocalHashCode & (len-1);  
  
	// 线性探测
    for (Entry e = tab[i];  
        e != null;  
        e = tab[i = nextIndex(i, len)]) {  
        
        // 1. 同key，直接覆盖
        if (e.refersTo(key)) {  
            e.value = value;  
            return;  
        }  
		  
		// 2. 旧entry，已被GC回收，直接插入/替换
        if (e.refersTo(null)) {  
            replaceStaleEntry(key, value, i);  
            return;  
        }  
    }  
  
    // 3. 空槽，直接插入
    tab[i] = new Entry(key, value);  
    int sz = ++size;  
    if (!cleanSomeSlots(i, sz) && sz >= threshold)  
        rehash();  
}
```

方法总结：
- 计算 key 的哈希定位到数组下标`i`
- 如遇冲突，线性探测向后找
- 遇到三种情况：
  1. 空槽：直接插入
  2. 同 key：覆盖 value
  3. **陈旧 entry（stale entry，key 已被 GC 成 null）**：触发替换/清理逻辑（例如 `replaceStaleEntry`），尽量把 stale 清掉并维持探测链正确

### 3.4. remove() 做了什么：将其从当前线程表中删除 + 触发重排

`ThreadLocal.remove()` 不是“把 ThreadLocal 清空”，而是从 `Thread.currentThread().threadLocals` 中移除该 key 对应的 entry。

```java
private void remove(ThreadLocal<?> key) {  
    Entry[] tab = table;  
    int len = tab.length;  
    int i = key.threadLocalHashCode & (len-1);  
    for (Entry e = tab[i];  
         e != null;  
         e = tab[i = nextIndex(i, len)]) {  
        if (e.refersTo(key)) {  
            e.clear();  
            expungeStaleEntry(i);  
            return;  
        }  
    }  
}

...

private int expungeStaleEntry(int staleSlot) {  
    Entry[] tab = table;  
    int len = tab.length;  
  
    // expunge entry at staleSlot  
    tab[staleSlot].value = null;  
    tab[staleSlot] = null;  
    size--;  
  
    // Rehash until we encounter null  
    Entry e;  
    int i;  
    for (i = nextIndex(staleSlot, len);  
         (e = tab[i]) != null;  
         i = nextIndex(i, len)) {  
        ThreadLocal<?> k = e.get();  
        if (k == null) {  
            e.value = null;  
            tab[i] = null;  
            size--;  
        } else {  
            int h = k.threadLocalHashCode & (len - 1);  
            if (h != i) {  
                tab[i] = null;  
  
                // Unlike Knuth 6.4 Algorithm R, we must scan until  
                // null because multiple entries could have been stale.                while (tab[h] != null)  
                h = nextIndex(h, len);  
                tab[h] = e;  
            }  
        }  
    }  
    return i;  
}
```

方法总结：
- 在开放定址结构里删除元素会“断链”，所以实现通常会：
	- 清空当前槽位
	- 调用 `expungeStaleEntry(...)` 的逻辑做**重排（rehash/expunge）**，确保后续 key 仍可被正确查到

---

## 4. 线程池“串号”与“疑似内存泄漏”：问题解释

### 4.1 为什么会串号

线程池会复用线程，而若上一个任务 `set()` 了 ThreadLocal 但没 `remove()`，下一个任务复用同一线程时 `get()` 会读到上次残留的值，这就是常见的“上下文串号”问题。

### 4.2 为什么会出现“疑似内存泄漏”

根因与引用类型和JVM回收机制有关：
- `Entry.key` 是弱引用，`ThreadLocal` 可被 GC 回收，导致key 变 `null`（过期）
- `Entry.value` 是强引用，仍挂在 `ThreadLocalMap.table` 里
- 当线程池线程生命周期很长，value 可能长期释放不了

所以严格说这更像是**value 的滞留**，而不是语言层面的永久泄漏；但在服务型线程池里表现就像泄漏一样严重。

### 4.3 为什么有时又会“自己恢复”

`ThreadLocalMap` 并非完全不管 stale entry。它会在 `get/set/remove` 等路径中**顺便清理**，这一点在上面的源码中也已经能观察到。常见的清理方法有：
- `expungeStaleEntry(i)`：从某位置开始清理并重排探测链
- `cleanSomeSlots(...)`：启发式清理一段，控制均摊开销
- `expungeStaleEntries()`：更彻底的全表清理（更重）

这种清理是“被动触发”的。若线程后续很少触达 map，滞留可能持续很久。

### 4.4. 最佳实践

因此，对于线程池/容器线程（Web 线程、RPC 线程、异步执行器线程），一定要确保对`ThreadLocal`在用后调用 `try/finally remove`，解决上下文串号（逻辑错误）和 value 滞留（内存风险）：

````java
try {
  TL.set(ctx);
  // do work
} finally {
  TL.remove();
}
````

---

## 5. 关于 InheritableThreadLocal

因为`ThreadLocal`值是存在`Thread`专属的表中的，这就导致在一些异步场景中，`ThreadLocal`值无法随着线程切换进行自动传递。对于跨线程传递`ThreadLocal`值的问题，JDK 原生提供的方案就是`InheritableThreadLocal`，直译正是“可继承的 ThreadLocal”。

`InheritableThreadLocal` 的表对应于 `Thread.inheritableThreadLocals`。子线程在**创建时**会把父线程相关 map 做拷贝/派生。

```java
// Thread 构造方法中的相关逻辑摘取
if (inheritThreadLocals && parent.inheritableThreadLocals != null)  
    this.inheritableThreadLocals =  
        ThreadLocal.createInheritedMap(parent.inheritableThreadLocals);
```

这种方案的缺陷在于，它仅是在线程创建时进行复制，是一次性的；而在线程池中，线程通常不是“新建”，而是复用，因此它经常不符合对“父子线程传递”的直觉预期，个人用的也比较少。

---

## 总结

- `ThreadLocal` 的隔离不是“ThreadLocal 内部隔离”，而是 **“每个线程各自持有一张 ThreadLocalMap”**
- `ThreadLocalMap` 通过数组 + 线性探测实现，key 为弱引用、value 为强引用
- 线程池场景中，不 `remove()` 会导致：
  - 业务层面“串号”
  - 内存层面 value 滞留（看起来像泄漏）
- 源码通过在 `get/set/remove` 中顺带清理 stale entry 来做均摊控制，但不可靠替代显式清理
- 最佳实践：**ThreadLocal 用完必 remove，且放 finally**
