---
title: Inception 学习笔记
date: '2026-02-15T17:13:59+08:00'
updated: '2026-03-09T09:24:12.782Z'
legacyPath: /2026/02/15/Inception学习笔记/
categories:
  - Computer Vision
tags:
  - GoogleNet
---

**此为旧博客补档，原文上传于2022年7月4日。**

### 前言

用英文写了前两篇笔记，主要是为了契合周报，但相对于读者可能不太友好，于是从这一篇开始还是用中文做笔记了。这次带来的是对GoogleNet V1的主要结构复现。

### 背景

上一篇笔记中我们复现的经典网络是VGGNet,它是2014年ImageNet大赛的第二名，而当年的第一名正是GoogleNet。如果说VGG只是对AlexNet的结构作改进，那么GoogleNet则是针对当时DNN设计的痛点做出了许多创新，提出了行之有效的解决方案。**随着网络长宽的不断增大和深度的不断加深，其准确度会相应不断提升，但同时参数也在急剧增多，过拟合发生的可能性也越来越大。** 当时，一般的DNN的构建思路如下：堆叠卷积层，间以池化层，并通过LRN，Dropout等技巧防止过拟合。然而对于稍深的DNN，对硬件的要求依然很高，问题没有很好地解决。比如VGG相对于AlexNet，换用了更小的卷积核，参数数量固然减少了，但基数依然很大。即便放到现在，笔者笔记本搭载的 RTX2060 也只能保证训练 VGG11(batch_size为32) 而不显存溢出，并且针对一个具有以万为单位的中型数据集能保证一、两个小时完成训练。

对此，GoogleNet主要提出了两点新的加快训练速度和减少参数数量的方案：
- 利用 1x1卷积核(Network in Network)对数据降维，同时增加非线性，并做到减少参数和防止过拟合。
- 提出Inception模块，可以理解为对相似尺度的特征提取的卷积核分组，将大的不利计算的稀疏矩阵转化为多个小的便于计算的密集矩阵，并且结合了1x1卷积核降维处理。Inception的灵感来自Hebbian principle，即如果两个神经元常常同时产生动作电位，这两个神经元之间的连接就会变强，反之则变弱。

### 网络结构

GoogleNet中主要涉及到3个网络结构：Inception Module，和Auxiliary Classifier，以及最终的GoogleNet主干网络。

#### Inception Module

直观来看，Inception其实就是将多个卷积和池化的操作放在一起组装为一个小型网络模块，使得神经网络的设计模块化。下图是Inception模块的结构：

![Inception](https://s2.loli.net/2022/07/04/G6PuijTULCxpN39.png)

从图中可见，Inception包含了一组不同卷积核大小的卷积核和一个必要的均值池化层。不同尺度的特征，往往需要不同大小的感受野来捕获。传统的网络结构中，在一层卷积层只能有一种大小卷积核，其能获得的特征不一定是最佳的，而可能需要别的大小的卷积核。Inception所做的正是将这一过程交给神经网络判断，网络通过调节参数，自主选择合适大小的卷积核。原始的Inception结构如图(a)所示，这样的结构仍会带来较多参数，不能直接用于网络。解决方案是加入先前所述的1x1卷积核，做到数据降维，减少参数数量，于是最终形成了图(b)所示的结构。
用Pytorch实现如下：

```python
class Inception(nn.Module):

    def __init__(self, ch_in, ch1x1, ch3x3_reduce, ch3x3, ch5x5_reduce, ch5x5, pool_proj):
        super().__init__()
        self.parallel1 = ReluConv(ch_in=ch_in, ch_out=ch1x1, kernel_size=1, stride=1)
        self.parallel2 = nn.Sequential(
            ReluConv(
                ch_in=ch_in,
                ch_out=ch3x3_reduce,
                kernel_size=1,
                stride=1
            ),
            ReluConv(
                ch_in=ch3x3_reduce,
                ch_out=ch3x3,
                kernel_size=3,
                stride=1,
                padding=1
            )
        )
        self.parallel3 = nn.Sequential(
            ReluConv(
                ch_in=ch_in,
                ch_out=ch5x5_reduce,
                kernel_size=1,
                stride=1
            ),
            ReluConv(
                ch_in=ch5x5_reduce,
                ch_out=ch5x5,
                kernel_size=5,
                stride=1,
                padding=2
            )
        )
        self.parallel4 = nn.Sequential(
            nn.MaxPool2d(kernel_size=3, stride=1, padding=1),
            ReluConv(
                ch_in=ch_in,
                ch_out=pool_proj,
                kernel_size=1,
                stride=1
            )
        )

    def forward(self, x):
        # Do DepthConcat
        parallel1 = self.parallel1(x)
        parallel2 = self.parallel2(x)
        parallel3 = self.parallel3(x)
        parallel4 = self.parallel4(x)
        return torch.cat((parallel1, parallel2, parallel3, parallel4), 1)
```

#### Auxiliary Classifier
Auxiliary Classifier，即辅助分类器，是为了增强梯度(防止出现梯度消失)，以及增加正则化而设计的一种子模块网络。它只在训练过程加入，其运算结果在乘以一个权重系数(0.3)后与最终输出结果一起作用于反向传播。它由一个均值池化层，一个1x1卷积+ReLU激活层，一个全连接层，一个Dropout层，和一个接了softmax的全连接层构成。

用pytorch实现如下：

```python
class AuxClassifier(nn.Module):

    def __init__(self, ch_in, num_classes=2):
        super().__init__()
        self.pool = nn.AvgPool2d(kernel_size=5, stride=3)
        self.conv = ReluConv(ch_in=ch_in, ch_out=128, kernel_size=1, stride=1)
        self.fc1 = nn.Linear(in_features=2048, out_features=1024)  # input is N x 128 x 4 x 4
        self.fc2 = nn.Linear(in_features=1024, out_features=num_classes)

    def forward(self, x):
        x = self.pool(x)
        x = self.conv(x)
        x = torch.flatten(x, 1)  # as input of fc layer
        x = self.fc1(x)
        x = F.relu(x)
        x = F.dropout(x, 0.7, training=self.training)
        x = self.fc2(x)
        return x
```

#### GoogleNet

GoogleNet的结构如下：

![Screenshot from 2022-07-04 20-41-50.png](https://s2.loli.net/2022/07/04/suoGLmEKOCyVw7c.png)

可见，在较浅层，主要组成部分依然是传统的卷积+池化。随后便是Inception模块的不断堆叠，间以最大池化，最后是dropout+全连接层输出分类结果。需要注意的是这里的全连接层实际上是一个均值池化层，通过7x7的滤波器大小，将前一层输入的7x7大小的特征直接转化为1x1。论文提到这里用池化层代替卷积层，实现了0.6%的准确度提升。

用pytorch实现如下：

```python
class GoogleNet(nn.Module):

    def __init__(self, num_classes=2, aux_enabled=True):
        super().__init__()
        '''
        input: 227 x 227 x 3
        output: 56 x 56 x 64
        '''
        self.conv1 = ReluConv(ch_in=3, ch_out=64, kernel_size=7, stride=2, padding=3)
        self.pool1 = nn.MaxPool2d(kernel_size=3, stride=2, ceil_mode=True)
        # LRN?

        '''
        input: 56 x 56 x 64
        output: 28 x 28 x 192
        '''
        self.conv2 = ReluConv(ch_in=64, ch_out=64, kernel_size=1, stride=1)
        self.conv3 = ReluConv(ch_in=64, ch_out=192, kernel_size=3, stride=1, padding=1)
        self.pool2 = nn.MaxPool2d(kernel_size=3, stride=2, ceil_mode=True)
        # LRN?

        '''
        input: 28 x 28 x 192
        output: 28 x 28 x 256  
        '''
        self.inception3a = Inception(
            ch_in=192,
            ch1x1=64,
            ch3x3_reduce=96,
            ch3x3=128,
            ch5x5_reduce=16,
            ch5x5=32,
            pool_proj=32
        )

        '''
        input: 28 x 28 x 256
        output: 14 x 14 x 480  
        '''
        self.inception3b = Inception(
            ch_in=256,
            ch1x1=128,
            ch3x3_reduce=128,
            ch3x3=192,
            ch5x5_reduce=32,
            ch5x5=96,
            pool_proj=64
        )
        self.pool3 = nn.MaxPool2d(kernel_size=3, stride=2, ceil_mode=True)

        '''
        input: 14 x 14 x 480
        output: 14 x 14 x 512  
        '''
        self.inception4a = Inception(
            ch_in=480,
            ch1x1=192,
            ch3x3_reduce=96,
            ch3x3=208,
            ch5x5_reduce=16,
            ch5x5=48,
            pool_proj=64
        )

        '''
        input: 14 x 14 x 512
        output: 14 x 14 x 512  
        '''
        self.inception4b = Inception(
            ch_in=512,
            ch1x1=160,
            ch3x3_reduce=112,
            ch3x3=224,
            ch5x5_reduce=24,
            ch5x5=64,
            pool_proj=64
        )

        '''
        input: 14 x 14 x 512
        output: 14 x 14 x 512  
        '''
        self.inception4c = Inception(
            ch_in=512,
            ch1x1=128,
            ch3x3_reduce=128,
            ch3x3=256,
            ch5x5_reduce=24,
            ch5x5=64,
            pool_proj=64
        )

        '''
        input: 14 x 14 x 512
        output: 14 x 14 x 528  
        '''
        self.inception4d = Inception(
            ch_in=512,
            ch1x1=112,
            ch3x3_reduce=144,
            ch3x3=288,
            ch5x5_reduce=32,
            ch5x5=64,
            pool_proj=64
        )

        '''
        input: 14 x 14 x 528
        output: 14 x 14 x 832  
        '''
        self.inception4e = Inception(
            ch_in=528,
            ch1x1=256,
            ch3x3_reduce=160,
            ch3x3=320,
            ch5x5_reduce=32,
            ch5x5=128,
            pool_proj=128
        )

        self.pool4 = nn.MaxPool2d(kernel_size=3, stride=2, ceil_mode=True)

        '''
        input: 7 x 7 x 832
        output: 7 x 7 x 832  
        '''
        self.inception5a = Inception(
            ch_in=832,
            ch1x1=256,
            ch3x3_reduce=160,
            ch3x3=320,
            ch5x5_reduce=32,
            ch5x5=128,
            pool_proj=128
        )

        '''
        input: 7 x 7 x 832
        output: 7 x 7 x 1024  
        '''
        self.inception5b = Inception(
            ch_in=832,
            ch1x1=384,
            ch3x3_reduce=192,
            ch3x3=384,
            ch5x5_reduce=48,
            ch5x5=128,
            pool_proj=128
        )

        '''
        input: 7 x 7 x 1024
        output: 1 x 1 x 1024  
        '''
        self.pool5 = nn.AvgPool2d(kernel_size=7, stride=1, ceil_mode=True)
        self.dropout = nn.Dropout(0.4)

        '''
        input: 1024
        output: 2  
        '''
        self.fc = nn.Linear(in_features=1024, out_features=num_classes)

        if aux_enabled:
            self.aux_enabled = True
            self.aux0 = AuxClassifier(ch_in=512, num_classes=2)
            self.aux1 = AuxClassifier(ch_in=528, num_classes=2)

    def forward(self, x):
        x = self.conv1(x)
        x = self.pool1(x)

        x = self.conv2(x)
        x = self.conv3(x)
        x = self.pool2(x)

        x = self.inception3a(x)
        x = self.inception3b(x)
        x = self.pool3(x)

        x = self.inception4a(x)
        if self.training and self.aux_enabled:
            aux0 = self.aux0(x)

        x = self.inception4b(x)
        x = self.inception4c(x)
        x = self.inception4d(x)
        if self.training and self.aux_enabled:
            aux1 = self.aux1(x)

        x = self.inception4e(x)
        x = self.pool4(x)
        x = self.inception5a(x)
        x = self.inception5b(x)

        x = self.pool5(x)
        x = torch.flatten(x, 1)
        x = self.dropout(x)
        x = self.fc(x)

        if self.training and self.aux_enabled:
            return x, aux0, aux1
        return x
```

注意这里我们和之前一样，用较小的数据集代替ImageNet，并对网络中输出层做相应调整。

### 训练

设置batch_size为32，经过20个epoch，得到训练结果如下：
loss图像：

![loss.png](https://s2.loli.net/2022/07/04/pqZOLAvFXQd1eKH.png)

accuracy图像：

![accuracy.png](https://s2.loli.net/2022/07/04/9k5G3gI2WZBJdqu.png)

这里依然出现了之前一样的问题：loss曲线剧烈抖动，同时accuracy每轮epoch开始有毛刺？新手上路，实在没弄清楚原因。虽然图像不甚完美，但可看到loss还是随训练总体上是降低的，而accuracy是升高的。并且在验证集中也能达到准确率目标。

### 结论

GoogleNet作为一种经典DNN，还有许多值得学习的设计思想，并且其本身也经过了多次迭代升级，这里仅仅是对初代GoogleNet(V1)进行了Pytorch的代码复现。

下一个学习目标定为ResNet的论文阅读和pytorch复现。
