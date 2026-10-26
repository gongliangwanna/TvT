/* Read-only lyrics lookup. Official API: https://lrclib.net/docs
 * Only song metadata / a supplied fragment leave this module; never pass chat history.
 * Unison discovers songs by lyric fragments; LRCLIB supplies the complete text.
 * Official discovery contract: https://github.com/better-lyrics/unison#api
 * A discovered or guessed title is accepted only after checking the supplied
 * fragment against LRCLIB's complete lyric body.
 */
(function (root) {
    'use strict';

    const BASE = 'https://lrclib.net/api';
    const DISCOVERY_BASE = 'https://unison.boidu.dev';
    const CLIENT = 'ST-UWU-PhoneLyrics/0.1 (https://github.com/dream-ice/uwu)';
    const REQUEST_TIMEOUT = 6500;
    const LOOKUP_TIMEOUT = 14500;
    const DISCOVERY_TIMEOUT = 30000;
    const CACHE_LIMIT = 24;
    const BODY_LIMIT = 1200000;
    const cache = new Map();
    let requestTail = Promise.resolve();
    let lastRequestAt = 0;
    const cooldowns = new Map();
    /* OpenCC TSCharacters matching table, version 1.1.9.
     * Source: https://raw.githubusercontent.com/BYVoid/OpenCC/ver.1.1.9/data/dictionary/TSCharacters.txt
     * OpenCC authors: BYVoid and contributors.
     * Used only for comparisons. Source lyrics are never converted.
     * Apache License
     * Version 2.0, January 2004
     * http://www.apache.org/licenses/
     * 
     * TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION
     * 
     * 1. Definitions.
     * 
     * "License" shall mean the terms and conditions for use, reproduction, and distribution as defined by Sections 1 through 9 of this document.
     * 
     * "Licensor" shall mean the copyright owner or entity authorized by the copyright owner that is granting the License.
     * 
     * "Legal Entity" shall mean the union of the acting entity and all other entities that control, are controlled by, or are under common control with that entity. For the purposes of this definition, "control" means (i) the power, direct or indirect, to cause the direction or management of such entity, whether by contract or otherwise, or (ii) ownership of fifty percent (50%) or more of the outstanding shares, or (iii) beneficial ownership of such entity.
     * 
     * "You" (or "Your") shall mean an individual or Legal Entity exercising permissions granted by this License.
     * 
     * "Source" form shall mean the preferred form for making modifications, including but not limited to software source code, documentation source, and configuration files.
     * 
     * "Object" form shall mean any form resulting from mechanical transformation or translation of a Source form, including but not limited to compiled object code, generated documentation, and conversions to other media types.
     * 
     * "Work" shall mean the work of authorship, whether in Source or Object form, made available under the License, as indicated by a copyright notice that is included in or attached to the work (an example is provided in the Appendix below).
     * 
     * "Derivative Works" shall mean any work, whether in Source or Object form, that is based on (or derived from) the Work and for which the editorial revisions, annotations, elaborations, or other modifications represent, as a whole, an original work of authorship. For the purposes of this License, Derivative Works shall not include works that remain separable from, or merely link (or bind by name) to the interfaces of, the Work and Derivative Works thereof.
     * 
     * "Contribution" shall mean any work of authorship, including the original version of the Work and any modifications or additions to that Work or Derivative Works thereof, that is intentionally submitted to Licensor for inclusion in the Work by the copyright owner or by an individual or Legal Entity authorized to submit on behalf of the copyright owner. For the purposes of this definition, "submitted" means any form of electronic, verbal, or written communication sent to the Licensor or its representatives, including but not limited to communication on electronic mailing lists, source code control systems, and issue tracking systems that are managed by, or on behalf of, the Licensor for the purpose of discussing and improving the Work, but excluding communication that is conspicuously marked or otherwise designated in writing by the copyright owner as "Not a Contribution."
     * 
     * "Contributor" shall mean Licensor and any individual or Legal Entity on behalf of whom a Contribution has been received by Licensor and subsequently incorporated within the Work.
     * 
     * 2. Grant of Copyright License. Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright license to reproduce, prepare Derivative Works of, publicly display, publicly perform, sublicense, and distribute the Work and such Derivative Works in Source or Object form.
     * 
     * 3. Grant of Patent License. Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable (except as stated in this section) patent license to make, have made, use, offer to sell, sell, import, and otherwise transfer the Work, where such license applies only to those patent claims licensable by such Contributor that are necessarily infringed by their Contribution(s) alone or by combination of their Contribution(s) with the Work to which such Contribution(s) was submitted. If You institute patent litigation against any entity (including a cross-claim or counterclaim in a lawsuit) alleging that the Work or a Contribution incorporated within the Work constitutes direct or contributory patent infringement, then any patent licenses granted to You under this License for that Work shall terminate as of the date such litigation is filed.
     * 
     * 4. Redistribution. You may reproduce and distribute copies of the Work or Derivative Works thereof in any medium, with or without modifications, and in Source or Object form, provided that You meet the following conditions:
     * 
     *    1. You must give any other recipients of the Work or Derivative Works a copy of this License; and
     * 
     *    2. You must cause any modified files to carry prominent notices stating that You changed the files; and
     * 
     *    3. You must retain, in the Source form of any Derivative Works that You distribute, all copyright, patent, trademark, and attribution notices from the Source form of the Work, excluding those notices that do not pertain to any part of the Derivative Works; and
     * 
     *    4. If the Work includes a "NOTICE" text file as part of its distribution, then any Derivative Works that You distribute must include a readable copy of the attribution notices contained within such NOTICE file, excluding those notices that do not pertain to any part of the Derivative Works, in at least one of the following places: within a NOTICE text file distributed as part of the Derivative Works; within the Source form or documentation, if provided along with the Derivative Works; or, within a display generated by the Derivative Works, if and wherever such third-party notices normally appear. The contents of the NOTICE file are for informational purposes only and do not modify the License. You may add Your own attribution notices within Derivative Works that You distribute, alongside or as an addendum to the NOTICE text from the Work, provided that such additional attribution notices cannot be construed as modifying the License.
     * 
     * You may add Your own copyright statement to Your modifications and may provide additional or different license terms and conditions for use, reproduction, or distribution of Your modifications, or for any such Derivative Works as a whole, provided Your use, reproduction, and distribution of the Work otherwise complies with the conditions stated in this License.
     * 
     * 5. Submission of Contributions. Unless You explicitly state otherwise, any Contribution intentionally submitted for inclusion in the Work by You to the Licensor shall be under the terms and conditions of this License, without any additional terms or conditions. Notwithstanding the above, nothing herein shall supersede or modify the terms of any separate license agreement you may have executed with Licensor regarding such Contributions.
     * 
     * 6. Trademarks. This License does not grant permission to use the trade names, trademarks, service marks, or product names of the Licensor, except as required for reasonable and customary use in describing the origin of the Work and reproducing the content of the NOTICE file.
     * 
     * 7. Disclaimer of Warranty. Unless required by applicable law or agreed to in writing, Licensor provides the Work (and each Contributor provides its Contributions) on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied, including, without limitation, any warranties or conditions of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A PARTICULAR PURPOSE. You are solely responsible for determining the appropriateness of using or redistributing the Work and assume any risks associated with Your exercise of permissions under this License.
     * 
     * 8. Limitation of Liability. In no event and under no legal theory, whether in tort (including negligence), contract, or otherwise, unless required by applicable law (such as deliberate and grossly negligent acts) or agreed to in writing, shall any Contributor be liable to You for damages, including any direct, indirect, special, incidental, or consequential damages of any character arising as a result of this License or out of the use or inability to use the Work (including but not limited to damages for loss of goodwill, work stoppage, computer failure or malfunction, or any and all other commercial damages or losses), even if such Contributor has been advised of the possibility of such damages.
     * 
     * 9. Accepting Warranty or Additional Liability. While redistributing the Work or Derivative Works thereof, You may choose to offer, and charge a fee for, acceptance of support, warranty, indemnity, or other liability obligations and/or rights consistent with this License. However, in accepting such obligations, You may act only on Your own behalf and on Your sole responsibility, not on behalf of any other Contributor, and only if You agree to indemnify, defend, and hold each Contributor harmless for any liability incurred by, or claims asserted against, such Contributor by reason of your accepting any such warranty or additional liability.
     * 
     * END OF TERMS AND CONDITIONS
     * 
     * 
     */
    const SIMPLIFY_PAIRS = "㑮𫝈㑯㑔㑳㑇㑶㐹㒓𠉂㓄𪠟㓨刾㔋𪟎㖮𪠵㗲𠵾㗿𪡛㘉𠰱㘓𪢌㘔𫬐㘚㘎㛝𫝦㜄㚯㜏㛣㜐𫝧㜗𡞋㜢𡞱㜷𡝠㞞𪨊㟺𪩇㠏㟆㠣𫵷㢗𪪑㢝𢋈㥮㤘㦎𢛯㦛𢗓㦞𪫷㨻𪮃㩋𪮋㩜㨫㩳㧐㩵擜㪎𪯋㯤𣘐㰙𣗙㵗𣳆㵾𪷍㶆𫞛㷍𤆢㷿𤈷㸇𤎺㹽𫞣㺏𤠋㺜𪺻㻶𪼋㿖𪽮㿗𤻊㿧𤽯䀉𥁢䀹𥅴䁪𥇢䁻䀥䂎𥎝䃮鿎䅐𫀨䅳𫀬䆉𫁂䉑𫁲䉙𥬀䉬𫂈䉲𥮜䉶𫁷䊭𥺅䊷䌶䊺𫄚䋃𫄜䋔𫄞䋙䌺䋚䌻䋦𫄩䋹䌿䋻䌾䋼𫄮䋿𦈓䌈𦈖䌋𦈘䌖𦈜䌝𦈟䌟𦈞䌥𦈠䌰𦈙䍤𫅅䍦䍠䍽𦍠䎙𫅭䎱䎬䓣𬜯䕤𫟕䕳𦰴䖅𫟑䗅𫊪䗿𧉞䙔𫋲䙡䙌䙱𧜭䚩𫌯䛄𫍠䛳𫍫䜀䜧䜖𫟢䝭𫎧䝻𧹕䝼䞍䞈𧹑䞋𫎪䞓𫎭䟃𫎺䟆𫎳䟐𫎱䠆𫏃䠱𨅛䡐𫟤䡩𫟥䡵𫟦䢨𨑹䤤𫟺䥄𫠀䥇䦂䥑鿏䥕𬭯䥗𫔋䥩𨱖䥯𫔆䥱䥾䦘𨸄䦛䦶䦟䦷䦯𫔵䦳𨷿䧢𨸟䪊𫖅䪏𩏼䪗𩐀䪘𩏿䪴𫖫䪾𫖬䫀𫖱䫂𫖰䫟𫖲䫴𩖗䫶𫖺䫻𫗇䫾𫠈䬓𫗊䬘𩙮䬝𩙯䬞𩙧䬧𫗟䭀𩠇䭃𩠈䭑𫗱䭔𫗰䭿𩧭䮄𫠊䮝𩧰䮞𩨁䮠𩧿䮫𩨇䮰𫘮䮳𩨏䮾𩧪䯀䯅䯤𩩈䰾鲃䱀𫚐䱁𫚏䱙𩾈䱧𫚠䱬𩾊䱰𩾋䱷䲣䱸𫠑䱽䲝䲁鳚䲅𫚜䲖𩾂䲘鳤䲰𪉂䳜𫛬䳢𫛰䳤𫛮䳧𫛺䳫𫛼䴉鹮䴋𫜅䴬𪎈䴱𫜒䴴𪎋䴽𫜔䵳𪑅䵴𫜙䶕𫜨䶲𫜳丟丢並并乾干亂乱亙亘亞亚佇伫佈布佔占併并來来侖仑侶侣侷局俁俣係系俓𠇹俔伣俠侠俥伡俬私倀伥倆俩倈俫倉仓個个們们倖幸倫伦倲㑈偉伟偑㐽側侧偵侦偽伪傌㐷傑杰傖伧傘伞備备傢家傭佣傯偬傳传傴伛債债傷伤傾倾僂偻僅仅僉佥僑侨僕仆僞伪僤𫢸僥侥僨偾僱雇價价儀仪儁俊儂侬億亿儈侩儉俭儎傤儐傧儔俦儕侪儘尽償偿儣𠆲優优儭𠋆儲储儷俪儸㑩儺傩儻傥儼俨兇凶兌兑兒儿兗兖內内兩两冊册冑胄冪幂凈净凍冻凙𪞝凜凛凱凯別别刪删剄刭則则剋克剎刹剗刬剛刚剝剥剮剐剴剀創创剷铲剾𠛅劃划劇剧劉刘劊刽劌刿劍剑劏㓥劑剂劚㔉勁劲勑𠡠動动務务勛勋勝胜勞劳勢势勣𪟝勩勚勱劢勳勋勵励勸劝勻匀匭匦匯汇匱匮區区協协卹恤卻却卽即厙厍厠厕厤历厭厌厲厉厴厣參参叄叁叢丛吒咤吳吴吶呐呂吕咼呙員员哯𠯟唄呗唓𪠳唸念問问啓启啞哑啟启啢唡喎㖞喚唤喪丧喫吃喬乔單单喲哟嗆呛嗇啬嗊唝嗎吗嗚呜嗩唢嗰𠮶嗶哔嗹𪡏嘆叹嘍喽嘓啯嘔呕嘖啧嘗尝嘜唛嘩哗嘪𪡃嘮唠嘯啸嘰叽嘳𪡞嘵哓嘸呒嘺𪡀嘽啴噁恶噅𠯠噓嘘噚㖊噝咝噞𪡋噠哒噥哝噦哕噯嗳噲哙噴喷噸吨噹当嚀咛嚇吓嚌哜嚐尝嚕噜嚙啮嚛𪠸嚥咽嚦呖嚧𠰷嚨咙嚮向嚲亸嚳喾嚴严嚶嘤嚽𪢕囀啭囁嗫囂嚣囃𠱞囅冁囈呓囉啰囌苏囑嘱囒𪢠囪囱圇囵國国圍围園园圓圆圖图團团圞𪢮垻坝埡垭埨𫭢埬𪣆埰采執执堅坚堊垩堖垴堚𪣒堝埚堯尧報报場场塊块塋茔塏垲塒埘塗涂塚冢塢坞塤埙塵尘塸𫭟塹堑塿𪣻墊垫墜坠墠𫮃墮堕墰坛墲𪢸墳坟墶垯墻墙墾垦壇坛壈𡒄壋垱壎埙壓压壗𡋤壘垒壙圹壚垆壜坛壞坏壟垄壠垅壢坜壣𪤚壩坝壪塆壯壮壺壶壼壸壽寿夠够夢梦夥伙夾夹奐奂奧奥奩奁奪夺奬奖奮奋奼姹妝妆姍姗姦奸娙𫰛娛娱婁娄婡𫝫婦妇婭娅媈𫝨媧娲媯妫媰㛀媼媪媽妈嫋袅嫗妪嫵妩嫺娴嫻娴嫿婳嬀妫嬃媭嬇𫝬嬈娆嬋婵嬌娇嬙嫱嬡嫒嬣𪥰嬤嬷嬦𫝩嬪嫔嬰婴嬸婶嬻𪥿孃娘孄𫝮孆𫝭孇𪥫孋㛤孌娈孎𡠟孫孙學学孻𡥧孾𪧀孿孪宮宫寀采寠𪧘寢寝實实寧宁審审寫写寬宽寵宠寶宝將将專专尋寻對对導导尷尴屆届屍尸屓屃屜屉屢屡層层屨屦屩𪨗屬属岡冈峯峰峴岘島岛峽峡崍崃崑昆崗岗崙仑崢峥崬岽嵐岚嵗岁嵼𡶴嵽𫶇嵾㟥嶁嵝嶄崭嶇岖嶈𡺃嶔嵚嶗崂嶘𡺄嶠峤嶢峣嶧峄嶨峃嶮崄嶸嵘嶹𫝵嶺岭嶼屿嶽岳巊𪩎巋岿巒峦巔巅巖岩巗𪨷巘𪩘巰巯巹卺帥帅師师帳帐帶带幀帧幃帏幓㡎幗帼幘帻幝𪩷幟帜幣币幩𪩸幫帮幬帱幹干幾几庫库廁厕廂厢廄厩廈厦廎庼廕荫廚厨廝厮廞𫷷廟庙廠厂廡庑廢废廣广廧𪪞廩廪廬庐廳厅弒弑弔吊弳弪張张強强彃𪪼彄𫸩彆别彈弹彌弥彎弯彔录彙汇彠彟彥彦彫雕彲彨彿佛後后徑径從从徠徕復复徵征徹彻徿𪫌恆恒恥耻悅悦悞悮悵怅悶闷悽凄惡恶惱恼惲恽惻恻愛爱愜惬愨悫愴怆愷恺愻𢙏愾忾慄栗態态慍愠慘惨慚惭慟恸慣惯慤悫慪怄慫怂慮虑慳悭慶庆慺㥪慼戚慾欲憂忧憊惫憐怜憑凭憒愦憖慭憚惮憢𢙒憤愤憫悯憮怃憲宪憶忆憸𪫺憹𢙐懀𢙓懇恳應应懌怿懍懔懎𢠁懞蒙懟怼懣懑懤㤽懨恹懲惩懶懒懷怀懸悬懺忏懼惧懾慑戀恋戇戆戔戋戧戗戩戬戰战戱戯戲戏戶户拋抛挩捝挱挲挾挟捨舍捫扪捱挨捲卷掃扫掄抡掆㧏掗挜掙挣掚𪭵掛挂採采揀拣揚扬換换揮挥揯搄損损搖摇搗捣搵揾搶抢摋𢫬摐𪭢摑掴摜掼摟搂摯挚摳抠摶抟摺折摻掺撈捞撊𪭾撏挦撐撑撓挠撝㧑撟挢撣掸撥拨撧𪮖撫抚撲扑撳揿撻挞撾挝撿捡擁拥擄掳擇择擊击擋挡擓㧟擔担據据擟𪭧擠挤擣捣擫𢬍擬拟擯摈擰拧擱搁擲掷擴扩擷撷擺摆擻擞擼撸擽㧰擾扰攄摅攆撵攋𪮶攏拢攔拦攖撄攙搀攛撺攜携攝摄攢攒攣挛攤摊攪搅攬揽敎教敓敚敗败敘叙敵敌數数斂敛斃毙斅𢽾斆敩斕斓斬斩斷断斸𣃁於于旂旗旣既昇升時时晉晋晛𬀪晝昼暈晕暉晖暐𬀩暘旸暢畅暫暂曄晔曆历曇昙曉晓曊𪰶曏向曖暧曠旷曥𣆐曨昽曬晒書书會会朥𦛨朧胧朮术東东枴拐柵栅柺拐査查桱𣐕桿杆梔栀梖𪱷梘枧梜𬂩條条梟枭梲棁棄弃棊棋棖枨棗枣棟栋棡㭎棧栈棲栖棶梾椏桠椲㭏楇𣒌楊杨楓枫楨桢業业極极榘矩榦干榪杩榮荣榲榅榿桤構构槍枪槓杠槤梿槧椠槨椁槫𣏢槮椮槳桨槶椢槼椝樁桩樂乐樅枞樑梁樓楼標标樞枢樠𣗊樢㭤樣样樤𣔌樧榝樫㭴樳桪樸朴樹树樺桦樿椫橈桡橋桥機机橢椭橫横橯𣓿檁檩檉柽檔档檜桧檟槚檢检檣樯檭𣘴檮梼檯台檳槟檵𪲛檸柠檻槛櫃柜櫅𪲎櫍𬃊櫓橹櫚榈櫛栉櫝椟櫞橼櫟栎櫠𪲮櫥橱櫧槠櫨栌櫪枥櫫橥櫬榇櫱蘖櫳栊櫸榉櫻樱欄栏欅榉欇𪳍權权欍𣐤欏椤欐𪲔欑𪴙欒栾欓𣗋欖榄欘𣚚欞棂欽钦歎叹歐欧歟欤歡欢歲岁歷历歸归歿殁殘残殞殒殢𣨼殤殇殨㱮殫殚殭僵殮殓殯殡殰㱩殲歼殺杀殻壳殼壳毀毁毆殴毊𪵑毿毵氂牦氈毡氌氇氣气氫氢氬氩氭𣱝氳氲氾泛汎泛汙污決决沒没沖冲況况泝溯洩泄洶汹浹浃浿𬇙涇泾涗涚涼凉淒凄淚泪淥渌淨净淩凌淪沦淵渊淶涞淺浅渙涣減减渢沨渦涡測测渾浑湊凑湋𣲗湞浈湧涌湯汤溈沩準准溝沟溡𪶄溫温溮浉溳涢溼湿滄沧滅灭滌涤滎荥滙汇滬沪滯滞滲渗滷卤滸浒滻浐滾滚滿满漁渔漊溇漍𬇹漚沤漢汉漣涟漬渍漲涨漵溆漸渐漿浆潁颍潑泼潔洁潕𣲘潙沩潚㴋潛潜潣𫞗潤润潯浔潰溃潷滗潿涠澀涩澅𣶩澆浇澇涝澐沄澗涧澠渑澤泽澦滪澩泶澫𬇕澬𫞚澮浍澱淀澾㳠濁浊濃浓濄㳡濆𣸣濕湿濘泞濚溁濛蒙濜浕濟济濤涛濧㳔濫滥濰潍濱滨濺溅濼泺濾滤濿𪵱瀂澛瀃𣽷瀅滢瀆渎瀇㲿瀉泻瀋沈瀏浏瀕濒瀘泸瀝沥瀟潇瀠潆瀦潴瀧泷瀨濑瀰弥瀲潋瀾澜灃沣灄滠灍𫞝灑洒灒𪷽灕漓灘滩灙𣺼灝灏灡㳕灣湾灤滦灧滟灩滟災灾為为烏乌烴烃無无煇𪸩煉炼煒炜煙烟煢茕煥焕煩烦煬炀煱㶽熂𪸕熅煴熉𤈶熌𤇄熒荧熓𤆡熗炝熚𤇹熡𤋏熰𬉼熱热熲颎熾炽燀𬊤燁烨燈灯燉炖燒烧燖𬊈燙烫燜焖營营燦灿燬毁燭烛燴烩燶㶶燻熏燼烬燾焘爃𫞡爄𤇃爇𦶟爍烁爐炉爖𤇭爛烂爥𪹳爧𫞠爭争爲为爺爷爾尔牀床牆墙牘牍牽牵犖荦犛牦犞𪺭犢犊犧牺狀状狹狭狽狈猌𪺽猙狰猶犹猻狲獁犸獃呆獄狱獅狮獊𪺷獎奖獨独獩𤞃獪狯獫猃獮狝獰狞獱㺍獲获獵猎獷犷獸兽獺獭獻献獼猕玀猡玁𤞤珼𫞥現现琱雕琺珐琿珲瑋玮瑒玚瑣琐瑤瑶瑩莹瑪玛瑲玱瑻𪻲瑽𪻐璉琏璊𫞩璕𬍤璗𬍡璝𪻺璡琎璣玑璦瑷璫珰璯㻅環环璵玙璸瑸璼𫞨璽玺璾𫞦璿璇瓄𪻨瓅𬍛瓊琼瓏珑瓔璎瓕𤦀瓚瓒瓛𤩽甌瓯甕瓮產产産产甦苏甯宁畝亩畢毕畫画異异畵画當当畼𪽈疇畴疊叠痙痉痠酸痮𪽪痾疴瘂痖瘋疯瘍疡瘓痪瘞瘗瘡疮瘧疟瘮瘆瘱𪽷瘲疭瘺瘘瘻瘘療疗癆痨癇痫癉瘅癐𤶊癒愈癘疠癟瘪癡痴癢痒癤疖癥症癧疬癩癞癬癣癭瘿癮瘾癰痈癱瘫癲癫發发皁皂皚皑皟𤾀皰疱皸皲皺皱盃杯盜盗盞盏盡尽監监盤盘盧卢盨𪾔盪荡眝𪾣眞真眥眦眾众睍𪾢睏困睜睁睞睐瞘眍瞜䁖瞞瞒瞤𥆧瞶瞆瞼睑矇蒙矉𪾸矑𪾦矓眬矚瞩矯矫硃朱硜硁硤硖硨砗硯砚碕埼碙𥐻碩硕碭砀碸砜確确碼码碽䂵磑硙磚砖磠硵磣碜磧碛磯矶磽硗磾䃅礄硚礆硷礎础礐𬒈礒𥐟礙碍礦矿礪砺礫砾礬矾礮𪿫礱砻祕秘祿禄禍祸禎祯禕祎禡祃禦御禪禅禮礼禰祢禱祷禿秃秈籼稅税稈秆稏䅉稜棱稟禀種种稱称穀谷穇䅟穌稣積积穎颖穠秾穡穑穢秽穩稳穫获穭穞窩窝窪洼窮穷窯窑窵窎窶窭窺窥竄窜竅窍竇窦竈灶竊窃竚𥩟竪竖竱𫁟競竞筆笔筍笋筧笕筴䇲箇个箋笺箏筝節节範范築筑篋箧篔筼篘𥬠篠筿篢𬕂篤笃篩筛篳筚篸𥮾簀箦簂𫂆簍篓簑蓑簞箪簡简簢𫂃簣篑簫箫簹筜簽签簾帘籃篮籅𥫣籋𥬞籌筹籔䉤籙箓籛篯籜箨籟籁籠笼籤签籩笾籪簖籬篱籮箩籲吁粵粤糉粽糝糁糞粪糧粮糰团糲粝糴籴糶粜糹纟糺𫄙糾纠紀纪紂纣紃𬘓約约紅红紆纡紇纥紈纨紉纫紋纹納纳紐纽紓纾純纯紕纰紖纼紗纱紘纮紙纸級级紛纷紜纭紝纴紞𬘘紟𫄛紡纺紬䌷紮扎細细紱绂紲绁紳绅紵纻紹绍紺绀紼绋紿绐絀绌絁𫄟終终絃弦組组絅䌹絆绊絍𫟃絎绗結结絕绝絙𫄠絛绦絝绔絞绞絡络絢绚絥𫄢給给絧𫄡絨绒絪𬘡絰绖統统絲丝絳绛絶绝絹绢絺𫄨綀𦈌綁绑綃绡綄𬘫綆绠綇𦈋綈绨綉绣綋𫟄綌绤綎𬘩綏绥綐䌼綑捆經经綖𫄧綜综綝𬘭綞缍綟𫄫綠绿綡𫟅綢绸綣绻綧𬘯綪𬘬綫线綬绶維维綯绹綰绾綱纲網网綳绷綴缀綵彩綸纶綹绺綺绮綻绽綽绰綾绫綿绵緄绲緇缁緊紧緋绯緍𦈏緑绿緒绪緓绬緔绱緗缃緘缄緙缂線线緝缉緞缎緟𫟆締缔緡缗緣缘緤𫄬緦缌編编緩缓緬缅緮𫄭緯纬緰𦈕緱缑緲缈練练緶缏緷𦈉緸𦈑緹缇緻致緼缊縈萦縉缙縊缢縋缒縍𫄰縎𦈔縐绉縑缣縕缊縗缞縛缚縝缜縞缟縟缛縣县縧绦縫缝縬𦈚縭缡縮缩縯𬙂縰𫄳縱纵縲缧縳䌸縴纤縵缦縶絷縷缕縸𫄲縹缥縺𦈐總总績绩繂𫄴繃绷繅缫繆缪繈𫄶繏𦈝繐𰬸繒缯繓𦈛織织繕缮繚缭繞绕繟𦈎繡绣繢缋繨𫄤繩绳繪绘繫系繬𫄱繭茧繮缰繯缳繰缲繳缴繶𫄷繷𫄣繸䍁繹绎繻𦈡繼继繽缤繾缱繿䍀纁𫄸纆𬙊纇颣纈缬纊纩續续纍累纏缠纓缨纔才纕𬙋纖纤纗𫄹纘缵纚𫄥纜缆缽钵罃䓨罈坛罌罂罎坛罰罚罵骂罷罢羅罗羆罴羈羁羋芈羣群羥羟羨羡義义羵𫅗羶膻習习翫玩翬翚翹翘翽翙耬耧耮耢聖圣聞闻聯联聰聪聲声聳耸聵聩聶聂職职聹聍聻𫆏聽听聾聋肅肃脅胁脈脉脛胫脣唇脥𣍰脩修脫脱脹胀腎肾腖胨腡脶腦脑腪𣍯腫肿腳脚腸肠膃腽膕腘膚肤膞䏝膠胶膢𦝼膩腻膹𪱥膽胆膾脍膿脓臉脸臍脐臏膑臗𣎑臘腊臚胪臟脏臠脔臢臜臥卧臨临臺台與与興兴舉举舊旧舘馆艙舱艣𫇛艤舣艦舰艫舻艱艰艷艳芻刍苧苎茲兹荊荆莊庄莖茎莢荚莧苋菕𰰨華华菴庵菸烟萇苌萊莱萬万萴荝萵莴葉叶葒荭葝𫈎葤荮葦苇葯药葷荤蒍𫇭蒐搜蒓莼蒔莳蒕蒀蒞莅蒭𫇴蒼苍蓀荪蓆席蓋盖蓧𦰏蓮莲蓯苁蓴莼蓽荜蔄𬜬蔔卜蔘参蔞蒌蔣蒋蔥葱蔦茑蔭荫蔯𫈟蔿𫇭蕁荨蕆蒇蕎荞蕒荬蕓芸蕕莸蕘荛蕝𫈵蕢蒉蕩荡蕪芜蕭萧蕳𫈉蕷蓣蕽𫇽薀蕰薆𫉁薈荟薊蓟薌芗薑姜薔蔷薘荙薟莶薦荐薩萨薳䓕薴苧薵䓓薹苔薺荠藍蓝藎荩藝艺藥药藪薮藭䓖藴蕴藶苈藷𫉄藹蔼藺蔺蘀萚蘄蕲蘆芦蘇苏蘊蕴蘋苹蘚藓蘞蔹蘟𦻕蘢茏蘭兰蘺蓠蘿萝虆蔂虉𬟁處处虛虚虜虏號号虧亏虯虬蛺蛱蛻蜕蜆蚬蝀𬟽蝕蚀蝟猬蝦虾蝨虱蝸蜗螄蛳螞蚂螢萤螮䗖螻蝼螿螀蟂𫋇蟄蛰蟈蝈蟎螨蟘𫋌蟜𫊸蟣虮蟬蝉蟯蛲蟲虫蟳𫊻蟶蛏蟻蚁蠀𧏗蠁蚃蠅蝇蠆虿蠍蝎蠐蛴蠑蝾蠔蚝蠙𧏖蠟蜡蠣蛎蠦𫊮蠨蟏蠱蛊蠶蚕蠻蛮蠾𧑏衆众衊蔑術术衕同衚胡衛卫衝冲袞衮裊袅裏里補补裝装裡里製制複复褌裈褘袆褲裤褳裢褸褛褻亵襀𫌀襇裥襉裥襏袯襓𫋹襖袄襗𫋷襘𫋻襝裣襠裆襤褴襪袜襬摆襯衬襰𧝝襲袭襴襕襵𫌇覈核見见覎觃規规覓觅視视覘觇覛𫌪覡觋覥觍覦觎親亲覬觊覯觏覲觐覷觑覹𫌭覺觉覼𫌨覽览覿觌觀观觴觞觶觯觸触訁讠訂订訃讣計计訊讯訌讧討讨訏𬣙訐讦訑𫍙訒讱訓训訕讪訖讫託托記记訛讹訜𫍛訝讶訞𫍚訟讼訢䜣訣诀訥讷訨𫟞訩讻訪访設设許许訴诉訶诃診诊註注証证詀𧮪詁诂詆诋詊𫟟詎讵詐诈詑𫍡詒诒詓𫍜詔诏評评詖诐詗诇詘诎詛诅詝𬣞詞词詠咏詡诩詢询詣诣試试詩诗詪𬣳詫诧詬诟詭诡詮诠詰诘話话該该詳详詵诜詷𫍣詼诙詿诖誂𫍥誄诔誅诛誆诓誇夸誋𫍪誌志認认誑诳誒诶誕诞誘诱誚诮語语誠诚誡诫誣诬誤误誥诰誦诵誨诲說说誫𫍨説说誰谁課课誳𫍮誴𫟡誶谇誷𫍬誹诽誺𫍧誼谊誾訚調调諂谄諄谆談谈諉诿請请諍诤諏诹諑诼諒谅諓𬣡論论諗谂諛谀諜谍諝谞諞谝諟𬤊諡谥諢诨諣𫍩諤谔諥𫍳諦谛諧谐諫谏諭谕諮咨諯𫍱諰𫍰諱讳諲𬤇諳谙諴𫍯諶谌諷讽諸诸諺谚諼谖諾诺謀谋謁谒謂谓謄誊謅诌謆𫍸謉𫍷謊谎謎谜謏𫍲謐谧謔谑謖谡謗谤謙谦謚谥講讲謝谢謠谣謡谣謨谟謫谪謬谬謭谫謯𫍹謱𫍴謳讴謸𫍵謹谨謾谩譁哗譂𫟠譅𰶎譆𫍻證证譊𫍢譎谲譏讥譑𫍤譓𬤝譖谮識识譙谯譚谭譜谱譞𫍽譟噪譨𫍦譫谵譭毁譯译議议譴谴護护譸诪譽誉譾谫讀读讅谉變变讋詟讌䜩讎雠讒谗讓让讕谰讖谶讚赞讜谠讞谳豈岂豎竖豐丰豔艳豬猪豵𫎆豶豮貓猫貗𫎌貙䝙貝贝貞贞貟贠負负財财貢贡貧贫貨货販贩貪贪貫贯責责貯贮貰贳貲赀貳贰貴贵貶贬買买貸贷貺贶費费貼贴貽贻貿贸賀贺賁贲賂赂賃赁賄贿賅赅資资賈贾賊贼賑赈賒赊賓宾賕赇賙赒賚赉賜赐賝𫎩賞赏賟𧹖賠赔賡赓賢贤賣卖賤贱賦赋賧赕質质賫赍賬账賭赌賰䞐賴赖賵赗賺赚賻赙購购賽赛賾赜贃𧹗贄贽贅赘贇赟贈赠贉𫎫贊赞贋赝贍赡贏赢贐赆贑𫎬贓赃贔赑贖赎贗赝贚𫎦贛赣贜赃赬赪趕赶趙赵趨趋趲趱跡迹踐践踰逾踴踊蹌跄蹔𫏐蹕跸蹟迹蹠跖蹣蹒蹤踪蹳𫏆蹺跷蹻𫏋躂跶躉趸躊踌躋跻躍跃躎䟢躑踯躒跞躓踬躕蹰躘𨀁躚跹躝𨅬躡蹑躥蹿躦躜躪躏軀躯軉𨉗車车軋轧軌轨軍军軏𫐄軑轪軒轩軔轫軕𫐅軗𨐅軛轭軜𫐇軝𬨂軟软軤轷軨𫐉軫轸軬𫐊軲轱軷𫐈軸轴軹轵軺轺軻轲軼轶軾轼軿𫐌較较輄𨐈輅辂輇辁輈辀載载輊轾輋𪨶輒辄輓挽輔辅輕轻輖𫐏輗𫐐輛辆輜辎輝辉輞辋輟辍輢𫐎輥辊輦辇輨𫐑輩辈輪轮輬辌輮𫐓輯辑輳辏輶𬨎輷𫐒輸输輻辐輼辒輾辗輿舆轀辒轂毂轄辖轅辕轆辘轇𫐖轉转轊𫐕轍辙轎轿轐𫐗轔辚轗𫐘轟轰轠𫐙轡辔轢轹轣𫐆轤轳辦办辭辞辮辫辯辩農农迴回逕迳這这連连週周進进遊游運运過过達达違违遙遥遜逊遞递遠远遡溯適适遱𫐷遲迟遷迁選选遺遗遼辽邁迈還还邇迩邊边邏逻邐逦郟郏郵邮鄆郓鄉乡鄒邹鄔邬鄖郧鄟𫑘鄧邓鄩𬩽鄭郑鄰邻鄲郸鄳𫑡鄴邺鄶郐鄺邝酇酂酈郦醃腌醖酝醜丑醞酝醟蒏醣糖醫医醬酱醱酦醲𬪩醶𫑷釀酿釁衅釃酾釅酽釋释釐厘釒钅釓钆釔钇釕钌釗钊釘钉釙钋釚𫟲針针釟𫓥釣钓釤钐釦扣釧钏釨𫓦釩钒釲𫟳釳𨰿釴𬬩釵钗釷钍釹钕釺钎釾䥺釿𬬱鈀钯鈁钫鈃钘鈄钭鈅钥鈆𫓪鈇𫓧鈈钚鈉钠鈋𨱂鈍钝鈎钩鈐钤鈑钣鈒钑鈔钞鈕钮鈖𫟴鈗𫟵鈛𫓨鈞钧鈠𨱁鈡钟鈣钙鈥钬鈦钛鈧钪鈮铌鈯𨱄鈰铈鈲𨱃鈳钶鈴铃鈷钴鈸钹鈹铍鈺钰鈽钸鈾铀鈿钿鉀钾鉁𨱅鉅巨鉆钻鉈铊鉉铉鉊𬬿鉋铇鉍铋鉑铂鉔𫓬鉕钷鉗钳鉚铆鉛铅鉝𫟷鉞钺鉠𫓭鉢钵鉤钩鉥𬬸鉦钲鉧𬭁鉬钼鉭钽鉮𬬹鉳锫鉶铏鉷𫟹鉸铰鉺铒鉻铬鉽𫟸鉾𫓴鉿铪銀银銁𫓲銂𫟻銃铳銅铜銈𫓯銊𫓰銍铚銏𫟶銑铣銓铨銖铢銘铭銚铫銛铦銜衔銠铑銣铷銥铱銦铟銨铵銩铥銪铕銫铯銬铐銱铞銳锐銶𨱇銷销銹锈銻锑銼锉鋁铝鋂𰾄鋃锒鋅锌鋇钡鋉𨱈鋌铤鋏铗鋐𬭎鋒锋鋗𫓶鋙铻鋝锊鋟锓鋠𫓵鋣铘鋤锄鋥锃鋦锔鋨锇鋩铓鋪铺鋭锐鋮铖鋯锆鋰锂鋱铽鋶锍鋸锯鋹𬬮鋼钢錀𬬭錁锞錂𨱋錄录錆锖錇锫錈锩錏铔錐锥錒锕錕锟錘锤錙锱錚铮錛锛錜𫓻錝𫓽錞𬭚錟锬錠锭錡锜錢钱錤𫓹錥𫓾錦锦錨锚錩锠錫锡錮锢錯错録录錳锰錶表錸铼錼镎錽𫓸鍀锝鍁锨鍃锪鍄𨱉鍅钫鍆钔鍇锴鍈锳鍉𫔂鍊炼鍋锅鍍镀鍒𫔄鍔锷鍘铡鍚钖鍛锻鍠锽鍤锸鍥锲鍩锘鍬锹鍭𬭤鍮𨱎鍰锾鍵键鍶锶鍺锗鍼针鍾钟鎂镁鎄锿鎇镅鎈𫟿鎊镑鎌镰鎍𫔅鎓𬭩鎔镕鎖锁鎘镉鎙𫔈鎚锤鎛镈鎝𨱏鎞𫔇鎡镃鎢钨鎣蓥鎦镏鎧铠鎩铩鎪锼鎬镐鎭镇鎮镇鎯𨱍鎰镒鎲镋鎳镍鎵镓鎶鿔鎷𨰾鎸镌鎿镎鏃镞鏆𨱌鏇旋鏈链鏉𨱒鏌镆鏍镙鏏𬭬鏐镠鏑镝鏗铿鏘锵鏚𬭭鏜镗鏝镘鏞镛鏟铲鏡镜鏢镖鏤镂鏥𫔊鏦𫓩鏨錾鏰镚鏵铧鏷镤鏹镪鏺䥽鏻𬭸鏽锈鏾𫔌鐃铙鐄𨱑鐇𫔍鐈𫓱鐋铴鐍𫔎鐎𨱓鐏𨱔鐐镣鐒铹鐓镦鐔镡鐘钟鐙镫鐝镢鐠镨鐥䦅鐦锎鐧锏鐨镄鐩𬭼鐪𫓺鐫镌鐮镰鐯䦃鐲镯鐳镭鐵铁鐶镮鐸铎鐺铛鐼𫔁鐽𫟼鐿镱鑀𰾭鑄铸鑉𫠁鑊镬鑌镔鑑鉴鑒鉴鑔镲鑕锧鑞镴鑠铄鑣镳鑥镥鑪𬬻鑭镧鑰钥鑱镵鑲镶鑴𫔔鑷镊鑹镩鑼锣鑽钻鑾銮鑿凿钁镢钂镋長长門门閂闩閃闪閆闫閈闬閉闭開开閌闶閍𨸂閎闳閏闰閐𨸃閑闲閒闲間间閔闵閗𫔯閘闸閝𫠂閞𫔰閡阂閣阁閤合閥阀閨闺閩闽閫阃閬阆閭闾閱阅閲阅閵𫔴閶阊閹阉閻阎閼阏閽阍閾阈閿阌闃阒闆板闇暗闈闱闉𬮱闊阔闋阕闌阑闍阇闐阗闑𫔶闒阘闓闿闔阖闕阙闖闯關关闞阚闠阓闡阐闢辟闤阛闥闼陘陉陝陕陞升陣阵陰阴陳陈陸陆陽阳隉陧隊队階阶隑𬮿隕陨際际隤𬯎隨随險险隮𬯀隯陦隱隐隴陇隸隶隻只雋隽雖虽雙双雛雏雜杂雞鸡離离難难雲云電电霑沾霢霡霣𫕥霧雾霼𪵣霽霁靂雳靄霭靆叇靈灵靉叆靚靓靜静靝靔靦腼靧𫖃靨靥鞏巩鞝绱鞦秋鞽鞒鞾𫖇韁缰韃鞑韆千韉鞯韋韦韌韧韍韨韓韩韙韪韚𫠅韛𫖔韜韬韝鞲韞韫韠𫖒韻韵響响頁页頂顶頃顷項项順顺頇顸須须頊顼頌颂頍𫠆頎颀頏颃預预頑顽頒颁頓顿頔𬱖頗颇領领頜颌頠𬱟頡颉頤颐頦颏頫𫖯頭头頮颒頰颊頲颋頴颕頵𫖳頷颔頸颈頹颓頻频頽颓顂𩓋顃𩖖顅𫖶顆颗題题額额顎颚顏颜顒颙顓颛顔颜顗𫖮願愿顙颡顛颠類类顢颟顣𫖹顥颢顧顾顫颤顬颥顯显顰颦顱颅顳颞顴颧風风颭飐颮飑颯飒颰𩙥颱台颳刮颶飓颷𩙪颸飔颺飏颻飖颼飕颾𩙫飀飗飄飘飆飙飈飚飋𫗋飛飞飠饣飢饥飣饤飥饦飦𫗞飩饨飪饪飫饫飭饬飯饭飱飧飲饮飴饴飵𫗢飶𫗣飼饲飽饱飾饰飿饳餃饺餄饸餅饼餈糍餉饷養养餌饵餎饹餏饻餑饽餒馁餓饿餔𫗦餕馂餖饾餗𫗧餘余餚肴餛馄餜馃餞饯餡馅餦𫗠餧𫗪館馆餪𫗬餫𫗥餬糊餭𫗮餱糇餳饧餵喂餶馉餷馇餸𩠌餺馎餼饩餾馏餿馊饁馌饃馍饅馒饈馐饉馑饊馓饋馈饌馔饑饥饒饶饗飨饘𫗴饜餍饞馋饟𫗵饠𫗩饢馕馬马馭驭馮冯馯𫘛馱驮馳驰馴驯馹驲馼𫘜駁驳駃𫘝駉𬳶駊𫘟駎𩧨駐驻駑驽駒驹駓𬳵駔驵駕驾駘骀駙驸駚𩧫駛驶駝驼駞𫘞駟驷駡骂駢骈駤𫘠駧𩧲駩𩧴駪𬳽駫𫘡駭骇駰骃駱骆駶𩧺駸骎駻𫘣駼𬳿駿骏騁骋騂骍騃𫘤騄𫘧騅骓騉𫘥騊𫘦騌骔騍骒騎骑騏骐騑𬴂騔𩨀騖骛騙骗騚𩨊騜𫘩騝𩨃騞𬴃騟𩨈騠𫘨騤骙騧䯄騪𩨄騫骞騭骘騮骝騰腾騱𫘬騴𫘫騵𫘪騶驺騷骚騸骟騻𫘭騼𫠋騾骡驀蓦驁骜驂骖驃骠驄骢驅驱驊骅驋𩧯驌骕驍骁驎𬴊驏骣驓𫘯驕骄驗验驙𫘰驚惊驛驿驟骤驢驴驤骧驥骥驦骦驨𫘱驪骊驫骉骯肮髏髅髒脏體体髕髌髖髋髮发鬆松鬍胡鬖𩭹鬚须鬠𫘽鬢鬓鬥斗鬧闹鬨哄鬩阋鬮阄鬱郁鬹鬶魎魉魘魇魚鱼魛鱽魟𫚉魢鱾魥𩽹魦𫚌魨鲀魯鲁魴鲂魵𫚍魷鱿魺鲄魽𫠐鮀𬶍鮁鲅鮃鲆鮄𫚒鮅𫚑鮆𫚖鮈𬶋鮊鲌鮋鲉鮍鲏鮎鲇鮐鲐鮑鲍鮒鲋鮓鲊鮚鲒鮜鲘鮝鲞鮞鲕鮟𩽾鮠𬶏鮡𬶐鮣䲟鮤𫚓鮦鲖鮪鲔鮫鲛鮭鲑鮮鲜鮯𫚗鮰𫚔鮳鲓鮵𫚛鮶鲪鮸𩾃鮺鲝鮿𫚚鯀鲧鯁鲠鯄𩾁鯆𫚙鯇鲩鯉鲤鯊鲨鯒鲬鯔鲻鯕鲯鯖鲭鯗鲞鯛鲷鯝鲴鯞𫚡鯡鲱鯢鲵鯤鲲鯧鲳鯨鲸鯪鲮鯫鲰鯬𫚞鯰鲶鯱𩾇鯴鲺鯶𩽼鯷鳀鯻𬶟鯽鲫鯾𫚣鯿鳊鰁鳈鰂鲗鰃鳂鰆䲠鰈鲽鰉鳇鰊𬶠鰋𫚢鰌䲡鰍鳅鰏鲾鰐鳄鰑𫚊鰒鳆鰓鳃鰕𫚥鰛鳁鰜鳒鰟鳑鰠鳋鰣鲥鰤𫚕鰥鳏鰦𫚤鰧䲢鰨鳎鰩鳐鰫𫚦鰭鳍鰮鳁鰱鲢鰲鳌鰳鳓鰵鳘鰶𬶭鰷鲦鰹鲣鰺鲹鰻鳗鰼鳛鰽𫚧鰾鳔鱀𬶨鱂鳉鱄𫚋鱅鳙鱆𫠒鱇𩾌鱈鳕鱉鳖鱊𫚪鱒鳟鱔鳝鱖鳜鱗鳞鱘鲟鱚𬶮鱝鲼鱟鲎鱠鲙鱢𫚫鱣鳣鱤鳡鱧鳢鱨鲿鱭鲚鱮𫚈鱯鳠鱲𫚭鱷鳄鱸鲈鱺鲡鳥鸟鳧凫鳩鸠鳬凫鳲鸤鳳凤鳴鸣鳶鸢鳷𫛛鳼𪉃鳽𫛚鳾䴓鴀𫛜鴃𫛞鴅𫛝鴆鸩鴇鸨鴉鸦鴐𫛤鴒鸰鴔𫛡鴕鸵鴗𫁡鴛鸳鴜𪉈鴝鸲鴞鸮鴟鸱鴣鸪鴥𫛣鴦鸯鴨鸭鴮𫛦鴯鸸鴰鸹鴲𪉆鴳𫛩鴴鸻鴷䴕鴻鸿鴽𫛪鴿鸽鵁䴔鵂鸺鵃鸼鵊𫛥鵏𬷕鵐鹀鵑鹃鵒鹆鵓鹁鵚𪉍鵜鹈鵝鹅鵟𫛭鵠鹄鵡鹉鵧𫛨鵩𫛳鵪鹌鵫𫛱鵬鹏鵮鹐鵯鹎鵰雕鵲鹊鵷鹓鵾鹍鶄䴖鶇鸫鶉鹑鶊鹒鶌𫛵鶒𫛶鶓鹋鶖鹙鶗𫛸鶘鹕鶚鹗鶠𬸘鶡鹖鶥鹛鶦𫛷鶩鹜鶪䴗鶬鸧鶭𫛯鶯莺鶰𫛫鶱𬸣鶲鹟鶴鹤鶹鹠鶺鹡鶻鹘鶼鹣鶿鹚鷀鹚鷁鹢鷂鹞鷄鸡鷅𫛽鷉䴘鷊鹝鷐𫜀鷓鹧鷔𪉑鷖鹥鷗鸥鷙鸷鷚鹨鷟𬸦鷣𫜃鷤𫛴鷥鸶鷦鹪鷨𪉊鷩𫜁鷫鹔鷭𬸪鷯鹩鷲鹫鷳鹇鷴鹇鷷𫜄鷸鹬鷹鹰鷺鹭鷽鸴鷿𬸯鸂㶉鸇鹯鸊䴙鸋𫛢鸌鹱鸏鹲鸑𬸚鸕鸬鸗𫛟鸘鹴鸚鹦鸛鹳鸝鹂鸞鸾鹵卤鹹咸鹺鹾鹼碱鹽盐麗丽麥麦麨𪎊麩麸麪面麫面麬𤿲麯曲麲𪎉麳𪎌麴曲麵面麷𫜑麼么麽么黃黄黌黉點点黨党黲黪黴霉黶黡黷黩黽黾黿鼋鼂鼌鼉鼍鼕冬鼴鼹齊齐齋斋齎赍齏齑齒齿齔龀齕龁齗龂齘𬹼齙龅齜龇齟龃齠龆齡龄齣出齦龈齧啮齩𫜪齪龊齬龉齭𫜭齮𬺈齯𫠜齰𫜬齲龋齴𫜮齶腭齷龌齼𬺓齾𫜰龍龙龎厐龐庞龑䶮龓𫜲龔龚龕龛龜龟龭𩨎龯𨱆鿁䜤鿓鿒𠁞𠀾𠌥𠆿𠏢𠉗𠐊𫝋𠗣㓆𠞆𠛆𠠎𠚳𠬙𪠡𠽃𪠺𠿕𪜎𡂡𪢒𡃄𪡺𡃕𠴛𡃤𪢐𡄔𠴢𡄣𠵸𡅏𠲥𡅯𪢖𡑍𫭼𡑭𡋗𡓁𪤄𡓾𡋀𡔖𡍣𡞵㛟𡟫𫝪𡠹㛿𡢃㛠𡮉𡭜𡮣𡭬𡳳𡳃𡸗𪨩𡹬𪨹𡻕岁𡽗𡸃𡾱㟜𡿖𪩛𢍰𪪴𢠼𢙑𢣐𪬚𢣚𢘝𢣭𢘞𢤩𪫡𢤱𢘙𢤿𪬯𢯷𪭝𢶒𪭯𢶫𢫞𢷮𢫊𢹿𢬦𢺳𪮳𣈶暅𣋋𣈣𣍐𫧃𣙎㭣𣜬𪳗𣝕𣘷𣞻𣘓𣠩𣞎𣠲𣑶𣯩𣯣𣯴𣭤𣯶毶𣽏𪶮𣾷㳢𣿉𣶫𤁣𣺽𤄷𪶒𤅶𣷷𤑳𤎻𤑹𪹀𤒎𤊀𤒻𪹹𤓌𪹠𤓎𤎺𤓩𤊰𤘀𪺣𤛮𤙯𤛱𫞢𤜆𪺪𤠮𪺸𤢟𤝢𤢻𢢐𤩂𫞧𤪺㻘𤫩㻏𤬅𪼴𤳷𪽝𤳸𤳄𤷃𪽭𤸫𤶧𤺔𪽴𥊝𥅿𥌃𥅘𥏝𪿊𥕥𥐰𥖅𥐯𥖲𪿞𥗇𪿵𥗽𬒗𥜐𫀓𥜰𫀌𥞵𥞦𥢢䅪𥢶𫞷𥢷𫀮𥨐𥧂𥪂𥩺𥯤𫁳𥴨𫂖𥴼𫁺𥵃𥱔𥵊𥭉𥶽𫁱𥸠𥮋𥻦𫂿𥼽𥹥𥽖𥺇𥾯𫄝𥿊𦈈𦀖𫄦𦂅𦈒𦃄𦈗𦃩𫄯𦅇𫄪𦅈𫄵𦆲𫟇𦒀𫅥𦔖𫅼𦘧𡳒𦟼𫆝𦠅𫞅𦡝𫆫𦢈𣍨𦣎𦟗𦧺𫇘𦪙䑽𦪽𦨩𦱌𫇪𦾟𦶻𧎈𧌥𧒯𫊹𧔥𧒭𧕟𧉐𧜗䘞𧜵䙊𧝞䘛𧞫𫌋𧟀𧝧𧡴𫌫𧢄𫌬𧦝𫍞𧦧𫍟𧩕𫍭𧩙䜥𧩼𫍶𧫝𫍺𧬤𫍼𧭈𫍾𧭹𫍐𧳟𧳕𧵳䞌𧶔𧹓𧶧䞎𧷎𪠀𧸘𫎨𧹈𪥠𧽯𫎸𨂐𫏌𨄣𨀱𨅍𨁴𨆪𫏕𨇁𧿈𨇞𨅫𨇤𫏨𨇰𫏞𨇽𫏑𨈊𨂺𨈌𨄄𨊰䢀𨊸䢁𨊻𨐆𨋢䢂𨌈𫐍𨍰𫐔𨎌𫐋𨎮𨐉𨏠𨐇𨏥𨐊𨞺𫟫𨟊𫟬𨢿𨡙𨣈𨡺𨣞𨟳𨣧𨠨𨤻𨤰𨥛𨱀𨥟𫓫𨦫䦀𨧀𬭊𨧜䦁𨧰𫟽𨧱𨱊𨨏𬭛𨨛𫓼𨨢𫓿𨩰𫟾𨪕𫓮𨫒𨱐𨬖𫔏𨭆𬭶𨭎𬭳𨭖𫔑𨭸𫔐𨮂𨱕𨮳𫔒𨯅䥿𨯟𫔓𨰃𫔉𨰋𫓳𨰥𫔕𨰲𫔃𨲳𫔖𨳑𨸁𨳕𨸀𨴗𨸅𨴹𫔲𨵩𨸆𨵸𨸇𨶀𨸉𨶏𨸊𨶮𨸌𨶲𨸋𨷲𨸎𨼳𫔽𨽏𨸘𩀨𫕚𩅙𫕨𩎖𫖑𩎢𩏾𩏂𫖓𩏠𫖖𩏪𩏽𩏷𫃗𩑔𫖪𩒎𫖭𩓣𩖕𩓥𫖵𩔑𫖷𩔳𫖴𩖰𫠇𩗀𩙦𩗓𫗈𩗴𫗉𩘀𩙩𩘝𩙭𩘹𩙨𩘺𩙬𩙈𩙰𩚛𩟿𩚥𩠀𩚩𫗡𩚵𩠁𩛆𩠂𩛌𫗤𩛡𫗨𩛩𩠃𩜇𩠉𩜦𩠆𩜵𩠊𩝔𩠋𩝽𫗳𩞄𩠎𩞦𩠏𩞯䭪𩟐𩠅𩟗𫗚𩠴𩠠𩡣𩡖𩡺𩧦𩢡𩧬𩢴𩧵𩢸𩧳𩢾𩧮𩣏𩧶𩣑䯃𩣫𩧸𩣵𩧻𩣺𩧼𩤊𩧩𩤙𩨆𩤲𩨉𩤸𩨅𩥄𩨋𩥇𩨍𩥉𩧱𩥑𩨌𩦠𫠌𩧆𩨐𩭙𩬣𩯁𫙂𩯳𩯒𩰀𩬤𩰹𩰰𩳤𩲒𩴵𩴌𩵦𫠏𩵩𩽺𩵹𩽻𩶁𫚎𩶘䲞𩶰𩽿𩶱𩽽𩷰𩾄𩸃𩾅𩸄𫚝𩸡𫚟𩸦𩾆𩻗𫚨𩻬𫚩𩻮𫚘𩼶𫚬𩽇𩾎𩿅𫠖𩿤𫛠𩿪𪉄𪀖𫛧𪀦𪉅𪀾𪉋𪁈𪉉𪁖𪉌𪂆𪉎𪃍𪉐𪃏𪉏𪃒𫛻𪃧𫛹𪄆𪉔𪄕𪉒𪅂𫜂𪆷𫛾𪇳𪉕𪈼𱊜𪉸𫜊𪋿𫧮𪌭𫜓𪍠𫜕𪓰𫜟𪔵𪔭𪘀𪚏𪘯𪚐𪙏𫜯𪟖𠛾𪷓𣶭𫒡𫓷𫜦𫜫";
    const simplifyCharacters = Array.from(SIMPLIFY_PAIRS);
    const simplifyMap = new Map();
    const traditionalSearchMap = new Map();
    for (let i = 0; i < simplifyCharacters.length; i += 2) {
        simplifyMap.set(simplifyCharacters[i], simplifyCharacters[i + 1]);
        if (!traditionalSearchMap.has(simplifyCharacters[i + 1])) traditionalSearchMap.set(simplifyCharacters[i + 1], simplifyCharacters[i]);
    }

    function failure(status, reason, extra) { return Object.assign({ status, reason }, extra || {}); }
    function normalize(value) {
        const normalized = String(value || '').normalize('NFKC').toLocaleLowerCase();
        return Array.from(normalized, character => simplifyMap.get(character) || character).join('')
            .replace(/[\s\p{P}\p{S}]+/gu, '');
    }
    function field(value, limit) {
        return typeof value === 'string' ? value.trim().slice(0, limit) : '';
    }
    function abortError(reason) {
        const error = new Error(reason || 'cancelled');
        error.name = 'AbortError';
        return error;
    }
    function wait(milliseconds, signal) {
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) { reject(abortError()); return; }
            const abort = () => { clearTimeout(timer); reject(abortError()); };
            const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
            signal?.addEventListener('abort', abort, { once: true });
        });
    }
    function abortable(promise, signal) {
        if (!signal) return promise;
        return new Promise((resolve, reject) => {
            if (signal.aborted) { reject(abortError()); return; }
            const abort = () => reject(abortError());
            signal.addEventListener('abort', abort, { once: true });
            promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        });
    }
    function retryDelay(value) {
        const seconds = Number(value);
        if (value && Number.isFinite(seconds)) return Math.min(86400000, Math.max(1000, seconds * 1000));
        const date = Date.parse(value || '');
        return Number.isFinite(date) ? Math.min(86400000, Math.max(1000, date - Date.now())) : 60000;
    }

    async function requestJson(path, signal, provider = 'lrclib') {
        const task = async () => {
            if (signal.aborted) throw abortError();
            if (Date.now() < (cooldowns.get(provider) || 0)) return { error: 'rate_limited' };
            await wait(Math.max(0, lastRequestAt + 250 - Date.now()), signal);
            if (Date.now() < (cooldowns.get(provider) || 0)) return { error: 'rate_limited' };
            lastRequestAt = Date.now();
            const controller = new AbortController();
            const abort = () => controller.abort();
            signal.addEventListener('abort', abort, { once: true });
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT);
            try {
                const response = await root.fetch((provider === 'unison' ? DISCOVERY_BASE : BASE) + path, {
                    method: 'GET', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer',
                    headers: provider === 'unison' ? { Accept: 'application/json' } : { Accept: 'application/json', 'Lrclib-Client': CLIENT },
                    signal: controller.signal
                });
                if (response.status === 429 || response.status === 503) {
                    cooldowns.set(provider, Date.now() + retryDelay(response.headers.get('Retry-After')));
                    return { error: response.status === 429 ? 'rate_limited' : 'unavailable' };
                }
                if (response.status === 404) return { data: null };
                if (!response.ok) return { error: 'http_' + response.status };
                if (!/\bapplication\/json\b/i.test(response.headers.get('Content-Type') || '')) return { error: 'invalid_response' };
                const size = Number(response.headers.get('Content-Length') || 0);
                if (size > BODY_LIMIT) return { error: 'response_too_large' };
                // Keep the timeout active while reading the body, too.
                const text = await response.text();
                if (text.length > BODY_LIMIT) return { error: 'response_too_large' };
                try { return { data: JSON.parse(text) }; }
                catch (_) { return { error: 'invalid_response' }; }
            } catch (error) {
                if (signal.aborted) throw abortError();
                return { error: timedOut ? 'timeout' : 'network' };
            } finally {
                clearTimeout(timer);
                signal.removeEventListener('abort', abort);
            }
        };
        const pending = requestTail.then(task, task);
        requestTail = pending.then(() => undefined, () => undefined);
        return abortable(pending, signal);
    }

    function parseLines(raw) {
        // Preserve source wording, whitespace, sequence and repeated choruses.
        return raw.split(/\r\n|\n|\r/).map(line => line
            .replace(/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g, '')
            .replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, ''));
    }
    function bodyLines(lines) {
        // Only known standalone section headings are metadata; arbitrary bracketed
        // wording remains part of the source lyric, as does a heading inside a line.
        const section = /^\s*\[(?:verse|chorus|pre[\s-]?chorus|post[\s-]?chorus|refrain|intro|outro|bridge|hook|interlude)(?:\s+\d+)?(?:\s*:\s*[^\]\r\n]+)?\]\s*$/i;
        return lines.filter(line => line.trim() && !/^\s*\[(?:ar|al|ti|by|offset|length|re|ve|au):[^\]]*\]\s*$/i.test(line) && !section.test(line));
    }
    function candidate(record) {
        if (!record || typeof record !== 'object' || record.instrumental === true) return null;
        if (record.preview === true || record.truncated === true || record.isPreview === true) return null;
        const title = field(record.trackName || record.name, 240);
        const artist = field(record.artistName, 240);
        const id = String(record.id || '');
        if (!title || !artist || !/^\d+$/.test(id)) return null;
        if (/(?:\b(?:preview|snippet)\b|仅供试听|试听版|歌词节选)/i.test(title)) return null;
        const raw = typeof record.plainLyrics === 'string' && record.plainLyrics.trim()
            ? record.plainLyrics : typeof record.syncedLyrics === 'string' ? record.syncedLyrics : '';
        if (!raw || raw.length > 100000) return null;
        const lines = parseLines(raw);
        const lyricLines = bodyLines(lines);
        const body = lyricLines.join('\n');
        if (lyricLines.length < 3 || normalize(body).length < 20) return null;
        if (/^\s*(?:\[(?:preview|snippet|truncated)\]|(?:歌词仅供试听|歌词已截断|以下为歌词节选)|(?:lyrics?\s+(?:preview|snippet|truncated)))\s*[:：]?/im.test(body)) return null;
        if (/^\s*(?:纯音乐[，,]?\s*请欣赏|此歌曲为没有填词的纯音乐|instrumental|no lyrics)\s*$/im.test(body)) return null;
        return {
            id: 'lrclib:' + id, title, artist, album: field(record.albumName, 240),
            source: 'LRCLIB', url: BASE + '/get/' + id,
            lyrics: raw, lines, lyricLines
        };
    }
    function metadata(song) {
        return { id: song.id, title: song.title, artist: song.artist, album: song.album, source: song.source, url: song.url };
    }
    function sameTitle(song, title) { return !title || normalize(song.title) === normalize(title); }
    function sameArtist(song, artist) { return !artist || normalize(song.artist) === normalize(artist); }
    function sameAlbum(song, album) { return !album || normalize(song.album) === normalize(album); }
    function fragmentMatches(song, fragment) {
        if (!fragment) return true;
        const needle = normalize(fragment);
        return needle.length >= 4 && normalize(song.lyricLines.join('\n')).includes(needle);
    }
    function choose(songs, input) {
        let eligible = songs.filter(song => sameTitle(song, input.title) && sameArtist(song, input.artist) && sameAlbum(song, input.album));
        if (input.fragment) eligible = eligible.filter(song => fragmentMatches(song, input.fragment));
        const unique = new Map();
        for (const song of eligible) {
            const key = normalize(song.title) + '|' + normalize(song.artist) + '|' + normalize(song.lyricLines.join('\n'));
            if (!unique.has(key)) unique.set(key, song);
        }
        const matches = [...unique.values()];
        if (matches.length === 1) return { status: 'found', song: matches[0] };
        if (matches.length > 1) return failure('ambiguous', 'ambiguous_song', { candidates: matches.slice(0, 8).map(metadata) });
        return failure('not_found', input.fragment ? 'fragment_not_verified' : 'no_matching_lyrics');
    }
    function cacheGet(key) {
        const entry = cache.get(key);
        if (!entry) return null;
        if (entry.until < Date.now()) { cache.delete(key); return null; }
        cache.delete(key); cache.set(key, entry);
        return JSON.parse(JSON.stringify(entry.result));
    }
    function remember(key, result) {
        if (result.status === 'unavailable') return result;
        if (result.status === 'found') {
            // 新取得的歌曲资料使旧的片段未命中结果失去时效；下次仍要在线反查，
            // 不能仅凭页内恰好只缓存一首含此短句的歌，就断言短句唯一属于它。
            for (const [storedKey, entry] of cache) {
                if (entry.result.status !== 'found') {
                    try { if (!JSON.parse(storedKey).title) cache.delete(storedKey); } catch (_) { /* 内部缓存键均由模块生成。 */ }
                }
            }
        }
        cache.set(key, { until: Date.now() + (result.status === 'found' ? 900000 : 30000), result: JSON.parse(JSON.stringify(result)) });
        while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
        return result;
    }
    function fragmentQueries(fragment) {
        // 搜索服务的全文索引不一定做简繁转换；变体仅用于查询，不改动来源歌词。
        const original = fragment.normalize('NFKC').trim();
        const simplified = Array.from(original, character => simplifyMap.get(character) || character).join('');
        const expanded = Array.from(simplified, character => traditionalSearchMap.get(character) || character).join('');
        return [...new Set([original, simplified, expanded])].filter(Boolean);
    }

    async function discover(input, signal) {
        const attempted = new Set();
        let lastError = '';
        for (const query of fragmentQueries(input.fragment)) {
            const parameters = new URLSearchParams({ q: query, limit: '3' });
            const result = await requestJson('/lyrics/search?' + parameters, signal, 'unison');
            if (result.error) return failure('unavailable', result.error);
            if (!result.data || result.data.success !== true || !Array.isArray(result.data.data)) return failure('unavailable', 'invalid_discovery_response');
            const discovered = [];
            for (const row of result.data.data.slice(0, 3)) {
                const title = field(row?.song, 240), artist = field(row?.artist, 240);
                if (!title || !artist || /[\r\n]/.test(title + artist)) continue;
                const key = normalize(title) + '|' + normalize(artist);
                if (!attempted.has(key)) { attempted.add(key); discovered.push({ title, artist }); }
            }
            const verified = [];
            for (const entry of discovered) {
                const artist = input.artist || entry.artist;
                const signature = new URLSearchParams({ track_name: entry.title, artist_name: artist });
                const exact = await requestJson('/get?' + signature, signal);
                const song = candidate(exact.data);
                // 规范名称可以不同于搜索源的别名，但用户限定的曲目与片段必须都吻合。
                if (song && sameTitle(song, entry.title) && sameArtist(song, input.artist) && sameAlbum(song, input.album) && fragmentMatches(song, input.fragment)) {
                    verified.push(song); continue;
                }
                const signatureSearch = new URLSearchParams({ track_name: entry.title });
                if (input.artist) signatureSearch.set('artist_name', input.artist);
                const search = await requestJson('/search?' + signatureSearch, signal);
                if (search.error) { lastError = search.error; continue; }
                if (!Array.isArray(search.data)) { lastError = 'invalid_response'; continue; }
                verified.push(...search.data.slice(0, 20).map(candidate).filter(Boolean)
                    .filter(item => sameTitle(item, entry.title) && sameArtist(item, input.artist) && sameAlbum(item, input.album) && fragmentMatches(item, input.fragment)));
            }
            const chosen = choose(verified, input);
            if (chosen.status === 'found') {
                // 另一首候选尚未完成核验时，唯一成功的结果不等于片段归属唯一。
                // /get 失败但后续 /search 成功则已经完成核验，不保留前者的临时故障。
                if (lastError) return failure('unavailable', lastError);
                chosen.song.discoverySource = 'Unison';
                chosen.song.discoveryUrl = DISCOVERY_BASE;
            }
            if (chosen.status !== 'not_found') return chosen;
            // q 也会命中无关歌曲元数据；只有全文核验成功才停止尝试简繁查询变体。
        }
        return lastError ? failure('unavailable', lastError) : failure('not_found', attempted.size ? 'fragment_not_verified' : 'fragment_not_found');
    }

    async function lookup(options) {
        const supplied = options || {};
        if (supplied.signal?.aborted) throw abortError();
        if (['title', 'artist', 'album'].some(name => typeof supplied[name] === 'string' && (supplied[name].length > 240 || /[\r\n]/.test(supplied[name])))
            || (typeof supplied.fragment === 'string' && supplied.fragment.length > 400)) return failure('not_found', 'invalid_query');
        const input = { title: field(supplied.title, 240), artist: field(supplied.artist, 240), album: field(supplied.album, 240), fragment: field(supplied.fragment, 400) };
        if (!input.title && !input.fragment) return failure('not_found', 'missing_query');
        if (input.fragment && normalize(input.fragment).length < 4) return failure('not_found', 'fragment_too_short');
        const key = JSON.stringify(input);
        // 仅复用同一查询已确认的结果；不能用缓存候选的局部唯一性代替全文反查。
        const hit = cacheGet(key);
        if (hit) return hit;
        if (typeof root.fetch !== 'function') return failure('unavailable', 'fetch_unavailable');
        const controller = new AbortController();
        const externalAbort = () => controller.abort();
        supplied.signal?.addEventListener('abort', externalAbort, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, input.title ? LOOKUP_TIMEOUT : DISCOVERY_TIMEOUT);
        try {
            if (!input.title) return remember(key, await discover(input, controller.signal));
            const errors = [];
            if (input.artist) {
                const signature = new URLSearchParams({ track_name: input.title, artist_name: input.artist });
                if (input.album) signature.set('album_name', input.album);
                const exact = await requestJson('/get?' + signature, controller.signal);
                if (exact.error) errors.push(exact.error);
                const song = candidate(exact.data);
                // /get is LRCLIB's selected canonical record for the signature.
                if (song && sameTitle(song, input.title) && sameArtist(song, input.artist) && sameAlbum(song, input.album) && fragmentMatches(song, input.fragment)) {
                    return remember(key, { status: 'found', song });
                }
                if (exact.error === 'rate_limited' || exact.error === 'unavailable') return failure('unavailable', exact.error);
            }
            const parameters = new URLSearchParams({ track_name: input.title });
            if (input.artist) parameters.set('artist_name', input.artist);
            if (input.album) parameters.set('album_name', input.album);
            const search = await requestJson('/search?' + parameters, controller.signal);
            if (search.error) errors.push(search.error);
            if (!Array.isArray(search.data)) {
                return failure('unavailable', errors[0] || 'invalid_response', { errors });
            }
            const result = choose(search.data.slice(0, 20).map(candidate).filter(Boolean), input);
            if (result.status === 'not_found' && errors.length) return failure('unavailable', errors[0], { errors });
            return remember(key, result);
        } catch (error) {
            if (supplied.signal?.aborted) throw abortError();
            return failure('unavailable', timedOut ? 'timeout' : 'network');
        } finally {
            clearTimeout(timer);
            supplied.signal?.removeEventListener('abort', externalAbort);
        }
    }

    root.PhoneLyricsSource = Object.freeze({ version: '0.1.0', lookup, normalizeForMatch: normalize, clearCache: () => cache.clear() });
})(typeof window !== 'undefined' ? window : globalThis);
