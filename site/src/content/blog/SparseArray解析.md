---
title: SparseArray解析
date: '2026-03-04T17:20:52+08:00'
updated: '2026-03-09T09:30:14.107Z'
legacyPath: /2026/03/04/SparseArray解析/
categories:
  - Android
tags:
  - 数据结构
---

**此为旧博客补档，原文上传于2022年3月23日。**

# 前言

数据结构是每个程序员的必修课。无论是链表，堆，队列，栈，还是树，图，无疑都是伟大的发明。而基于这些数据结构之上的集合(collections)，更是被广泛运用。在java开发中，我们经常使用诸如arrayList,hashmap这样的集合，对这些想必我们都已非常熟悉；然而，在android开发中，其实也有着一些特有的数据结构。使用这些数据结构，有时也许会带来出乎意料的优化效果，今天，我们就来分析一波稀疏数组(sparse array)。稀疏数组是android特有的集合，其作用类似于map，但是通过两个数组分别存储key和value。都用来存储键值对，但是短小精悍（其源码带上注释也不过500行），且拥有一套非常独特的机制。

# sparseArray字段

sparseArray有如下一些字段，我们一一进行分析：


```java
    private static final Object DELETED = new Object();
    private boolean mGarbage = false;

    @UnsupportedAppUsage(maxTargetSdk = 28) // Use keyAt(int)
    private int[] mKeys;
    @UnsupportedAppUsage(maxTargetSdk = 28) // Use valueAt(int), setValueAt(int, E)
    private Object[] mValues;
    @UnsupportedAppUsage(maxTargetSdk = 28) // Use size()
    private int mSize;
```

首先看mKeys数组，这是一个int类型数组，用来存储key，其值正是对应的value在mValues数组中的下标。可以看到sparsearray内部采用int类型表示key，而不像map,set一样可以自己通过泛型定义key的类型。这决定了sparsearray拥有一些独特的性质：(1)keys数组按照升序排序，通过二分查找定位key（而不是使用hash）；(2)避免了一些装箱、拆箱的过程，提高了效率。

然后是mValues数组，从名字就可以看出这个数组存储value。sparsearray使用Object类型而不是泛型来存储value。

接着是一个int类型变量mSize,代表mKeys和mValues**有效**的长度（也是二分查找过程的右基准）。
然后是DELETED。这是sparseArray的**延迟删除**机制的体现，其是一个object类型对象，用于在删除键值对时替换原来的旧值。然后是mGarbage，这是一个bool类型变量。当数组中存在被标记为删除（但没有真正删除）的元素（即DELETED）时，这个标记位会变为true，表示数组中存在无效的废弃值（就像垃圾一样），用以触发sparseArray的gc（注意这里是sparseArray自己的一个方法，而不是系统的gc）。
初步了解这些字段后，我们就可以看看sparsearray的方法，并洞悉其原理了。

# contains(int key)

这个方法用来查找某一key是否在数组中存在。其内部调用了另一方法indexOfKey：

```java
    public int indexOfKey(int key) {
        if (mGarbage) {
            gc();
        }

        return ContainerHelpers.binarySearch(mKeys, mSize, key);
    }
```

首先检查mGarbage值，如果为true，说明数组中存在无效元素，应该先调用gc清除再查找。关于gc()方法下文再做分析。这里我们可以先看一看返回中的binarySearch方法，sparseArray中大量使用这个方法。其与JavaSE中的二分查找有什么不同：

```java
    class ContainerHelpers {

        // This is Arrays.binarySearch(), but doesn't do any argument validation.
        static int binarySearch(int[] array, int size, int value) {
            int lo = 0;
            int hi = size - 1;

            while (lo <= hi) {
                final int mid = (lo + hi) >>> 1;
                final int midVal = array[mid];

                if (midVal < value) {
                    lo = mid + 1;
                } else if (midVal > value) {
                    hi = mid - 1;
                } else {
                    return mid;  // value found
                }
            }
            return ~lo;  // value not present
        }

        static int binarySearch(long[] array, int size, long value) {
            int lo = 0;
            int hi = size - 1;

            while (lo <= hi) {
                final int mid = (lo + hi) >>> 1;
                final long midVal = array[mid];

                if (midVal < value) {
                    lo = mid + 1;
                } else if (midVal > value) {
                    hi = mid - 1;
                } else {
                    return mid;  // value found
                }
            }
            return ~lo;  // value not present
        }
    }
```

首先这个方法写在ContainerHelpers这个工具类中，这个类只有这一个方法的两种重载。基本代码是正宗的二分查找写法，而重要区别在于最后当查找失败时返回的值：~lo。一般二分查找会返回-1这样没有意义的负值，表示元素不存在，但这里返回的却是最后一次查找时得到的low值取反。这是非常优秀的设计。这也是一个负值，但为什么标新立异，要返回这样的值呢？这是因为，sparseArray通过二分查找寻找key，而二分查找的前提是数组有序。当找不到一个key时，证明我们需要在mKeys数组中插入这个key，且其插入的位置应该满足升序。又因为，当二分查找失败时，最后应该有low = high = mid，而这个low正是理想的插入位置，在这个位置上插入新的key，数组整体依然保持有序。所以我们希望知道这个位置的值，以方便下次插入。但又需要提醒调用者查找是失败的（即需要负值这样的特殊值），所以最终就对low取反并返回。这样，我们既能知道二分查找失败，当前key不存在，又能知道应该插入的理想位置，一举两得。

# delete(int key)

我们接下来先讲sparseArray比较重要的删除操作。源码如下：

```java
    public void delete(int key) {
        int i = ContainerHelpers.binarySearch(mKeys, mSize, key);

        if (i >= 0) {
            if (mValues[i] != DELETED) {
                mValues[i] = DELETED;
                mGarbage = true;
            }
        }
    }
```

其思路十分清晰，也验证了我们之前所说：当要根据key删除一个value时，首先二分查找从mKeys中找到value的位置，如果i不为负，说明key确实存在，继续判断：如果当前元素不是DELETED(即为有效元素)，就需要把它删除：设为DELETED，并将mGarbage设为true。这便是**延迟删除**：并没有真实地删除这一元素，其key值依然存在且有效。只有当调用gc()时，才会真正删除这些元素。除delete外还有一个removeReturnOld方法，效果同delete，只是多了返回旧值的功能；delete还有一个别名方法remove。

细心的读者应该已经注意到，我们反复提到了”延迟删除”这一机制。为什么sparseArray非要搞这么个机制？为什么不直接删掉元素呢？其实这正是为了减少数组迁移的次数，从而提高效率。我们通过接下来的put方法就能体会到这种设计的好处。

# put(int key, E value)

```java
    public void put(int key, E value) {
        int i = ContainerHelpers.binarySearch(mKeys, mSize, key);

        if (i >= 0) {
            mValues[i] = value;
        } else {
            i = ~i;

            if (i < mSize && mValues[i] == DELETED) {
                mKeys[i] = key;
                mValues[i] = value;
                return;
            }

            if (mGarbage && mSize >= mKeys.length) {
                gc();

                // Search again because indices may have changed.
                i = ~ContainerHelpers.binarySearch(mKeys, mSize, key);
            }

            mKeys = GrowingArrayUtils.insert(mKeys, mSize, i, key);
            mValues = GrowingArrayUtils.insert(mValues, mSize, i, value);
            mSize++;
        }
    }
```

顺着源码，我们可以很容易地得出sparseArray插入键值对的思路：首先，还是从mKeys数组中二分查找当前key是否已经存在。如果已经有相同的key，则直接用当前新的value覆盖掉原来key对应的value。而如果没有当前key，就先对二分查找返回的i取反，即得到了当前key应该插入的位置。接下来就找到这个位置，看看其value是否为DELETED（延迟删除标记值），如果是，则证明当前值已经被废弃，可以直接覆盖，插入也就完成了；否则，就说明数组满了，无法插入。

重点来了：通常情况下，当遇到数组已满而需要插入新值时，需要对数组进行扩容。ArrayList就采取这样的思路。但对于sparseArray来说，这时会触发其延迟删除机制，从而规避了大部分可能需要扩容的情况。下面我们来看gc()方法：

```
    private void gc() {
        // Log.e("SparseArray", "gc start with " + mSize);

        int n = mSize;
        int o = 0;
        int[] keys = mKeys;
        Object[] values = mValues;

        for (int i = 0; i < n; i++) {
            Object val = values[i];

            if (val != DELETED) {
                if (i != o) {
                    keys[o] = keys[i];
                    values[o] = val;
                    values[i] = null;
                }

                o++;
            }
        }

        mGarbage = false;
        mSize = o;

        // Log.e("SparseArray", "gc end with " + mSize);
    }
```

gc()方法的实现思路很简单。首先，取数组旧的有效长度mSize（由于触发gc时数组内有DELETED元素，所以实际上新的有效长度应该减小）赋值给n，同时新建一个初值为0的int变量o。从下面的代码可以看出，这个o即代表新的有效长度。接下来对values数组进行遍历：如果当前值不为DELETED，且当前位置i != o，则说明**在当前位置前存在DELETED元素**，且其下标正是o。因此覆盖位置o处的keys和values，同时将当前位置的value置零。同时因为遇到了有效元素，o自加1。就这样迭代下去，最后values数组会被整理成前o个位置均为有效元素，后面则为null，所有的DELETED元素全部删除。也就是在此时，无效的keys和values才真正被清除。最后将象征有garbage的标志位置为false，同时更新有效长度mSize为o，一次gc就结束了。

回到之前的put()方法，由于进行了gc，此时的数组中可能出现了能够插入的空位，因此再做一次二分查找，并尝试插入。最后，我们就来看看执行插入的方法：

```java
    public static int[] insert(int[] array, int currentSize, int index, int element) {
        assert currentSize <= array.length;
        if (currentSize + 1 <= array.length) {
            System.arraycopy(array, index, array, index + 1, currentSize - index);
            array[index] = element;
            return array;
        int[] newArray = ArrayUtils.newUnpaddedIntArray(growSize(currentSize));
        System.arraycopy(array, 0, newArray, 0, index);
        newArray[index] = element;
        System.arraycopy(array, index, newArray, index + 1, array.length - index);
        return newArray;
        }
    }
```

如果currentSize + 1 <= array.length，说明数组仍有插入空间，无需扩容，则直接调用arraycopy将需要插入的地方index后所有元素往后平移一位，再将待插入元素赋给index位置。否则，实在没有办法，需要扩容了。
总结一下put()的流程：检查key是否已经存在-->已经存在，直接覆盖值；不存在-->待插入位置为DELETED，直接覆盖；为有效值-->触发gc-->gc后有空位，插入；仍然没有空位-->扩容并插入。

# get(int key)

最后简单地看一下get方法：

```java
    public E get(int key) {
        return get(key, null);
    }

    /**
     * Gets the Object mapped from the specified key, or the specified Object
     * if no such mapping has been made.
     */
    @SuppressWarnings("unchecked")
    public E get(int key, E valueIfKeyNotFound) {
        int i = ContainerHelpers.binarySearch(mKeys, mSize, key);

        if (i < 0 || mValues[i] == DELETED) {
            return valueIfKeyNotFound;
        } else {
            return (E) mValues[i];
        }
    }
```

就是二分查找，没什么好说的。

# 总结
以上就是sparseArray基本的操作方法。同相同功能的hashmap相比，其采用简单的数组和int存储，成本更低，避免装箱，且在数据量较小时，随机访问的速度也很快。但是虽然采取了延迟删除，其插入操作仍可能需要复制数组，导致效率降低；当数据量增大到一定规模时，其他方法（如gc()）等需要遍历数组，也相当费时，弊端越来越明显。因此，我们可以权衡sparseArray和hashmap不同的使用情景，合理选择，提高效率。
